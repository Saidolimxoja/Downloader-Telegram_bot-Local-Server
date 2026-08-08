// src/modules/premium/referral.service.ts

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Bot, Context } from 'grammy';
import { PrismaService } from '../../database/prisma.service';
import { TELEGRAM_BOT } from '../telegram/telegram.module';
import { PremiumService } from './premium.service';
import { REFERRAL_REWARD_DAYS } from './premium.constants';

/** Префикс реферальной ссылки: t.me/bot?start=ref_123456 */
const REFERRAL_PREFIX = 'ref_';

/**
 * 🎁 РЕФЕРАЛЬНАЯ ПРОГРАММА
 *
 * Самый дешёвый способ роста: пользователи приводят пользователей, а платит
 * за это бот днями премиума, а не деньгами. Растущая база — это то, что
 * потом продаётся рекламодателям и владельцам каналов.
 */
@Injectable()
export class ReferralService {
  private readonly logger = new Logger(ReferralService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly premiumService: PremiumService,
    @Inject(TELEGRAM_BOT) private readonly bot: Bot<Context>,
  ) {}

  /**
   * Разобрать полезную нагрузку команды /start.
   * Возвращает id пригласившего или null, если ссылка обычная.
   */
  parsePayload(payload?: string): bigint | null {
    if (!payload?.startsWith(REFERRAL_PREFIX)) return null;

    const raw = payload.slice(REFERRAL_PREFIX.length).trim();
    if (!/^\d{1,20}$/.test(raw)) return null;

    try {
      return BigInt(raw);
    } catch {
      return null;
    }
  }

  /**
   * Засчитать приглашение.
   *
   * Вызывается только для НОВОГО пользователя: иначе достаточно было бы
   * перейти по чужой ссылке повторно, чтобы бесконечно начислять дни.
   */
  async register(newUserId: bigint, referrerId: bigint): Promise<void> {
    // Пригласить самого себя нельзя — самая очевидная попытка накрутки
    if (newUserId === referrerId) return;

    try {
      const [newUser, referrer] = await this.prisma.$transaction([
        this.prisma.user.findUnique({
          where: { id: newUserId },
          select: { referredBy: true },
        }),
        this.prisma.user.findUnique({
          where: { id: referrerId },
          select: { id: true, isBanned: true },
        }),
      ]);

      // Пригласивший должен существовать и не быть забаненным
      if (!referrer || referrer.isBanned) return;

      // Приглашение засчитывается один раз и навсегда
      if (newUser?.referredBy) return;

      await this.prisma.$transaction([
        this.prisma.user.update({
          where: { id: newUserId },
          data: { referredBy: referrerId },
        }),
        this.prisma.user.update({
          where: { id: referrerId },
          data: { referralCount: { increment: 1 } },
        }),
      ]);

      await this.premiumService.grantDays(referrerId, REFERRAL_REWARD_DAYS);
      await this.notifyReferrer(referrerId);

      this.logger.log(`🎁 ${referrerId} пригласил ${newUserId}`);
    } catch (error: any) {
      // Реферальная механика не должна ломать сам /start
      this.logger.warn(`⚠️ Не удалось засчитать приглашение: ${error.message}`);
    }
  }

  /** Статистика для экрана «Пригласить друзей» */
  async getStats(userId: bigint): Promise<{ count: number; link: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { referralCount: true },
    });

    return {
      count: user?.referralCount ?? 0,
      link: await this.buildLink(userId),
    };
  }

  /**
   * Персональная ссылка. Имя бота берём у самого Telegram и держим в памяти:
   * оно не меняется, а дёргать getMe на каждый показ незачем.
   */
  async buildLink(userId: bigint): Promise<string> {
    if (!this.botUsername) {
      const me = await this.bot.api.getMe();
      this.botUsername = me.username;
    }

    return `https://t.me/${this.botUsername}?start=${REFERRAL_PREFIX}${userId}`;
  }

  private botUsername: string | null = null;

  private async notifyReferrer(referrerId: bigint): Promise<void> {
    try {
      await this.bot.api.sendMessage(
        Number(referrerId),
        `🎁 По твоей ссылке пришёл новый пользователь!\n\n` +
          `Тебе начислено ${REFERRAL_REWARD_DAYS} дня премиума 💎`,
      );
    } catch {
      // Пригласивший мог заблокировать бота — начисление всё равно состоялось
    }
  }
}
