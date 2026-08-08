import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { Advertisement } from '@prisma/client';
import { Bot, Context, InlineKeyboard } from 'grammy';
import { TELEGRAM_BOT } from '../telegram/telegram.module';
import { ClickTrackingService } from './click-tracking.service';
import { CreateAdDto } from './dto/create-ad.dto';
import { RedisService } from '../../common/redis/redis.service';
import {
  REDIS_KEYS,
  REDIS_TTL,
} from '../../common/constants/redis-keys.constant';

@Injectable()
export class AdvertisementService {
  private readonly logger = new Logger(AdvertisementService.name);

  /** Кеш активных объявлений в памяти процесса */
  private activeAdsCache: Advertisement[] | null = null;
  private activeAdsExpireAt = 0;
  private static readonly ADS_CACHE_MS = 60_000;

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private clickTracking: ClickTrackingService,
    @Inject(TELEGRAM_BOT) private readonly bot: Bot<Context>,
  ) {}

  /**
   * Проверить, пора ли показать рекламу.
   *
   * Счётчик загрузок раньше жил в Map внутри процесса: он рос без выселения,
   * обнулялся при каждом рестарте и, что хуже, при нескольких процессах у
   * пользователя оказывалось несколько независимых счётчиков — реклама
   * показывалась чаще, чем задумано. Теперь счётчик один, в Redis, с TTL.
   */
  async shouldShowAd(userId: bigint): Promise<boolean> {
    const activeAds = await this.getActiveAds();
    if (activeAds.length === 0) return false;

    const count = await this.redis.getCount(REDIS_KEYS.adCounter(userId));
    const minInterval = Math.min(...activeAds.map((ad) => ad.showInterval));

    if (count >= minInterval) {
      await this.redis.del(REDIS_KEYS.adCounter(userId));
      return true;
    }

    return false;
  }

  /**
   * Увеличить счётчик загрузок пользователя
   */
  async incrementUserDownloads(userId: bigint): Promise<void> {
    await this.redis.incrWithTtl(
      REDIS_KEYS.adCounter(userId),
      REDIS_TTL.adCounter,
    );
  }

  /**
   * Показать рекламу пользователю
   */
  async showAd(ctx: Context): Promise<void> {
    if (!ctx.from || !ctx.chat) {
      this.logger.warn('Реклама не показана: нет ctx.from / ctx.chat');
      return;
    }

    await this.showAdToChat(ctx.chat.id, BigInt(ctx.from.id));
  }

  /**
   * Показ рекламы без ctx — по идентификатору чата.
   *
   * Нужен воркеру: он отдаёт готовое видео уже вне обработчика сообщения,
   * где никакого ctx нет. Раньше из-за этого реклама показывалась только при
   * попадании в кеш, а после реальной загрузки — никогда.
   */
  async showAdToChat(chatId: number, userId: bigint): Promise<void> {
    const ads = await this.getActiveAds();
    if (ads.length === 0) return;

    const ad = ads[Math.floor(Math.random() * ads.length)];
    this.logger.log(`📣 Показ рекламы ID:${ad.id} пользователю ${userId}`);

    try {
      const keyboard = new InlineKeyboard();

      if (ad.buttonText && ad.buttonUrl) {
        // Ведём кнопку через свой редирект, чтобы посчитать переход.
        // Если домен не настроен — вернётся исходная ссылка рекламодателя.
        const url = this.clickTracking.buildClickUrl(
          ad.id,
          userId,
          ad.buttonUrl,
        );
        if (url) keyboard.url(ad.buttonText, url);
      }

      if (ad.mediaFileId) {
        await this.bot.api.sendPhoto(chatId, ad.mediaFileId, {
          caption: ad.content,
          reply_markup: keyboard,
        });
      } else {
        await this.bot.api.sendMessage(chatId, ad.content, {
          reply_markup: keyboard,
        });
      }

      // Статистику пишем только после успешной отправки — иначе счётчик
      // показов рос бы и на заблокировавших бота пользователях
      await this.recordView(ad.id, userId).catch((error: Error) =>
        this.logger.warn(`⚠️ Статистика показа: ${error.message}`),
      );
    } catch (error: any) {
      this.logger.warn(`⚠️ Не удалось показать рекламу: ${error.message}`);
    }
  }

  /**
   * Записать просмотр рекламы
   */
  private async recordView(adId: number, userId: bigint): Promise<void> {
    await Promise.all([
      this.prisma.advertisementView.create({ data: { adId, userId } }),
      this.prisma.advertisement.update({
        where: { id: adId },
        data: { viewCount: { increment: 1 } },
      }),
    ]);
  }

  /**
   * Записать клик по рекламе
   */
  async recordClick(adId: number, userId: bigint): Promise<void> {
    await Promise.all([
      // Обновляем запись просмотра
      this.prisma.advertisementView.updateMany({
        where: {
          adId,
          userId,
          clicked: false,
        },
        data: {
          clicked: true,
        },
      }),
      // Увеличиваем счётчик кликов
      this.prisma.advertisement.update({
        where: { id: adId },
        data: {
          clickCount: { increment: 1 },
        },
      }),
    ]);
  }

  /**
   * Активные объявления.
   *
   * Читается после каждой загрузки — то есть тысячи раз в день, — а меняется
   * раз в неделю. Держим минуту в памяти процесса, чтобы не долбить БД.
   */
  async getActiveAds(): Promise<Advertisement[]> {
    const now = Date.now();

    if (this.activeAdsCache && now < this.activeAdsExpireAt) {
      return this.activeAdsCache;
    }

    const ads = await this.prisma.advertisement.findMany({
      where: { isActive: true },
    });

    this.activeAdsCache = ads;
    this.activeAdsExpireAt = now + AdvertisementService.ADS_CACHE_MS;

    return ads;
  }

  /** Сброс кеша объявлений после правок в админке */
  private invalidateAdsCache(): void {
    this.activeAdsCache = null;
    this.activeAdsExpireAt = 0;
  }

  /**
   * Получить все объявления (для админки)
   */
  async getAll(): Promise<Advertisement[]> {
    return this.prisma.advertisement.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Создать объявление
   */
  async create(dto: CreateAdDto): Promise<Advertisement> {
    const ad = await this.prisma.advertisement.create({
      data: {
        content: dto.content,
        mediaFileId: dto.mediaFileId,
        buttonText: dto.buttonText,
        buttonUrl: dto.buttonUrl,
        isActive: dto.isActive ?? true,
        showInterval: dto.showInterval ?? 5,
      },
    });

    this.invalidateAdsCache();
    return ad;
  }

  async findOne(id: number) {
    return this.prisma.advertisement.findUnique({
      where: { id },
    });
  }

  async update(id: number, data: Partial<CreateAdDto>) {
    const ad = await this.prisma.advertisement.update({
      where: { id },
      data: {
        ...(data.content && { content: data.content }),
        ...(data.mediaFileId !== undefined && {
          mediaFileId: data.mediaFileId,
        }),
        ...(data.buttonText !== undefined && { buttonText: data.buttonText }),
        ...(data.buttonUrl !== undefined && { buttonUrl: data.buttonUrl }),
        ...(data.showInterval && { showInterval: data.showInterval }),
      },
    });

    this.invalidateAdsCache();
    return ad;
  }

  /**
   * Удалить объявление
   */
  async delete(id: number): Promise<void> {
    // Просмотры ссылаются на объявление внешним ключом — без их удаления
    // Postgres не даст удалить саму запись
    await this.prisma.$transaction([
      this.prisma.advertisementView.deleteMany({ where: { adId: id } }),
      this.prisma.advertisement.delete({ where: { id } }),
    ]);

    this.invalidateAdsCache();
  }

  /**
   * Переключить активность
   */
  async toggleActive(id: number): Promise<Advertisement> {
    const ad = await this.prisma.advertisement.findUnique({
      where: { id },
      select: { isActive: true },
    });

    if (!ad) {
      throw new Error('Объявление не найдено');
    }

    const updated = await this.prisma.advertisement.update({
      where: { id },
      data: { isActive: !ad.isActive },
    });

    this.invalidateAdsCache();
    return updated;
  }

  /**
   * Получить статистику объявления
   */
  async getAdStats(id: number) {
    const ad = await this.prisma.advertisement.findUnique({
      where: { id },
      include: {
        views: true,
      },
    });

    if (!ad) {
      throw new Error('Объявление не найдено');
    }

    const ctr =
      ad.viewCount > 0
        ? ((ad.clickCount / ad.viewCount) * 100).toFixed(2)
        : '0.00';

    return {
      ...ad,
      ctr: `${ctr}%`,
      uniqueViews: new Set(ad.views.map((v) => v.userId.toString())).size,
    };
  }

  /**
   * Общая статистика всех объявлений
   */
  async getTotalStats() {
    const ads = await this.prisma.advertisement.findMany();

    const totalViews = ads.reduce((sum, ad) => sum + ad.viewCount, 0);
    const totalClicks = ads.reduce((sum, ad) => sum + ad.clickCount, 0);
    const ctr =
      totalViews > 0 ? ((totalClicks / totalViews) * 100).toFixed(2) : '0.00';

    return {
      totalAds: ads.length,
      activeAds: ads.filter((ad) => ad.isActive).length,
      totalViews,
      totalClicks,
      ctr: `${ctr}%`,
    };
  }
}
