// src/modules/premium/premium.service.ts

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Bot, Context, InlineKeyboard } from 'grammy';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { TELEGRAM_BOT } from '../telegram/telegram.module';
import {
  PREMIUM_BENEFITS,
  PREMIUM_PLANS,
  PremiumPlan,
  findPlan,
} from './premium.constants';

/** Ключи и сроки кеша статуса подписки */
const PREMIUM_CACHE_KEY = (userId: bigint) => `premium:${userId}`;
const PREMIUM_CACHE_TTL = 5 * 60;

@Injectable()
export class PremiumService {
  private readonly logger = new Logger(PremiumService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Inject(TELEGRAM_BOT) private readonly bot: Bot<Context>,
  ) {}

  // ==================== ПРОВЕРКА СТАТУСА ====================

  /**
   * Есть ли действующий премиум.
   *
   * Проверяется на каждой загрузке, при показе рекламы и при проверке
   * лимитов, поэтому результат кешируется в Redis на 5 минут. Кеш общий для
   * бота и воркеров, а при покупке сбрасывается явно — человек не должен
   * ждать пять минут после оплаты.
   */
  async isPremium(userId: bigint): Promise<boolean> {
    if (userId <= 0n) return false;

    const cached = await this.redis.get(PREMIUM_CACHE_KEY(userId));
    if (cached !== null) return cached === '1';

    let active = false;

    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { premiumUntil: true },
      });

      active = !!user?.premiumUntil && user.premiumUntil > new Date();
    } catch (error: any) {
      // Сбой БД не должен превращать платящего пользователя в обычного
      // посреди работы — но и премиум незнакомцу выдавать нельзя.
      // Отвечаем «нет» и не кешируем, чтобы попробовать снова.
      this.logger.warn(`⚠️ Проверка премиума ${userId}: ${error.message}`);
      return false;
    }

    await this.redis.setEx(
      PREMIUM_CACHE_KEY(userId),
      active ? '1' : '0',
      PREMIUM_CACHE_TTL,
    );

    return active;
  }

  /** Полный статус — для экрана «Мой премиум» */
  async getStatus(
    userId: bigint,
  ): Promise<{ isPremium: boolean; until: Date | null }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { premiumUntil: true },
    });

    const until = user?.premiumUntil ?? null;
    return { isPremium: !!until && until > new Date(), until };
  }

  async invalidateCache(userId: bigint): Promise<void> {
    await this.redis.del(PREMIUM_CACHE_KEY(userId));
  }

  // ==================== НАЧИСЛЕНИЕ ====================

  /**
   * Продлить премиум на указанное число дней.
   *
   * Считаем от текущей даты окончания, если она ещё не прошла: покупка
   * второго месяца не должна обнулять остаток первого. Если подписка
   * истекла — считаем от «сейчас».
   */
  async grantDays(userId: bigint, days: number): Promise<Date> {
    const now = new Date();

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { premiumUntil: true },
    });

    const base =
      user?.premiumUntil && user.premiumUntil > now ? user.premiumUntil : now;

    const until = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);

    await this.prisma.user.update({
      where: { id: userId },
      data: { premiumUntil: until },
    });

    await this.invalidateCache(userId);
    this.logger.log(
      `💎 Премиум для ${userId} продлён до ${until.toISOString()}`,
    );

    return until;
  }

  // ==================== ОПЛАТА ====================

  /**
   * Выставить счёт в звёздах.
   *
   * Для Telegram Stars валюта — XTR, provider_token не нужен вовсе, а сумма
   * указывается прямо в звёздах (без домножения на 100, как у обычных валют).
   */
  async sendInvoice(chatId: number, plan: PremiumPlan): Promise<void> {
    await this.bot.api.sendInvoice(
      chatId,
      `Премиум на ${plan.title}`,
      PREMIUM_BENEFITS.join('\n'),
      // payload вернётся к нам в successful_payment — по нему поймём тариф
      `premium:${plan.id}`,
      'XTR',
      [{ label: `Премиум ${plan.title}`, amount: plan.stars }],
    );
  }

  /**
   * Обработать успешный платёж.
   *
   * Возвращает дату окончания подписки или null, если платёж уже был
   * обработан раньше. Идемпотентность обеспечивает уникальный индекс на
   * telegramChargeId: Telegram может прислать успешный платёж повторно, и
   * без этого пользователь получил бы дни дважды.
   */
  async applyPayment(params: {
    userId: bigint;
    payload: string;
    stars: number;
    chargeId: string;
  }): Promise<{ until: Date; plan: PremiumPlan } | null> {
    const planId = params.payload.replace('premium:', '');
    const plan = findPlan(planId);

    if (!plan) {
      this.logger.error(`❌ Неизвестный тариф в платеже: ${params.payload}`);
      return null;
    }

    try {
      await this.prisma.payment.create({
        data: {
          userId: params.userId,
          stars: params.stars,
          days: plan.days,
          telegramChargeId: params.chargeId,
        },
      });
    } catch (error: any) {
      // P2002 — такой charge_id уже записан, значит платёж обработан
      if (error.code === 'P2002') {
        this.logger.warn(`⚠️ Повторный платёж ${params.chargeId} — пропускаю`);
        return null;
      }
      throw error;
    }

    const until = await this.grantDays(params.userId, plan.days);
    return { until, plan };
  }

  /**
   * Вернуть звёзды за платёж.
   *
   * Telegram требует от ботов, продающих цифровые товары за звёзды,
   * возможности возврата. Премиум при возврате снимаем — иначе платёж
   * возвращается, а услуга остаётся.
   */
  async refund(chargeId: string): Promise<{ ok: boolean; message: string }> {
    const payment = await this.prisma.payment.findUnique({
      where: { telegramChargeId: chargeId },
    });

    if (!payment) {
      return {
        ok: false,
        message: 'Платёж с таким идентификатором не найден.',
      };
    }

    if (payment.refunded) {
      return { ok: false, message: 'Этот платёж уже возвращён.' };
    }

    try {
      await this.bot.api.refundStarPayment(Number(payment.userId), chargeId);
    } catch (error: any) {
      return {
        ok: false,
        message: `Telegram отказал в возврате: ${error.message}`,
      };
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payment.userId },
      select: { premiumUntil: true },
    });

    // Отматываем срок ровно на оплаченное количество дней
    const rolledBack = user?.premiumUntil
      ? new Date(
          user.premiumUntil.getTime() - payment.days * 24 * 60 * 60 * 1000,
        )
      : null;

    await this.prisma.$transaction([
      this.prisma.payment.update({
        where: { id: payment.id },
        data: { refunded: true, refundedAt: new Date() },
      }),
      this.prisma.user.update({
        where: { id: payment.userId },
        data: { premiumUntil: rolledBack },
      }),
    ]);

    await this.invalidateCache(payment.userId);

    return {
      ok: true,
      message: `Возвращено ${payment.stars} ⭐ пользователю ${payment.userId}.`,
    };
  }

  // ==================== ИНТЕРФЕЙС ====================

  /** Клавиатура выбора тарифа */
  buildPlansKeyboard(): InlineKeyboard {
    const keyboard = new InlineKeyboard();

    for (const plan of PREMIUM_PLANS) {
      keyboard.text(`${plan.title} — ${plan.stars} ⭐`, `buy:${plan.id}`).row();
    }

    return keyboard;
  }

  /** Статистика продаж для админки */
  async getSalesStats() {
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [totals, month, activeSubscribers] = await this.prisma.$transaction([
      this.prisma.payment.aggregate({
        where: { refunded: false },
        _sum: { stars: true },
        _count: true,
      }),
      this.prisma.payment.aggregate({
        where: { refunded: false, createdAt: { gte: monthAgo } },
        _sum: { stars: true },
        _count: true,
      }),
      this.prisma.user.count({ where: { premiumUntil: { gt: new Date() } } }),
    ]);

    return {
      totalStars: totals._sum.stars ?? 0,
      totalPayments: totals._count,
      monthStars: month._sum.stars ?? 0,
      monthPayments: month._count,
      activeSubscribers,
    };
  }
}
