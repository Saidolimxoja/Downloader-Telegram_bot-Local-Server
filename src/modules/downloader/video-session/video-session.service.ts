// src/modules/downloader/video-session/video-session.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { RedisService } from '../../../common/redis/redis.service';
import {
  REDIS_KEYS,
  REDIS_TTL,
} from '../../../common/constants/redis-keys.constant';
import { VideoInfoDto } from '../dto/video-info.dto';

/**
 * 💾 ХРАНИЛИЩЕ ДАННЫХ ВИДЕО МЕЖДУ АНАЛИЗОМ И НАЖАТИЕМ КНОПКИ
 *
 * Когда пользователь присылает ссылку, мы разбираем её и показываем кнопки
 * качества. Между показом и нажатием нужно где-то держать разобранные данные.
 *
 * Раньше это была Map в памяти процесса плюс запись в Postgres. С разделением
 * на бот и воркеры схема сломалась бы: анализ идёт в воркере, а кнопку
 * обрабатывает бот — у него в памяти пусто.
 *
 * Теперь Redis — основное хранилище (общее для всех процессов, TTL сам чистит),
 * Postgres — резервное: переживает перезапуск Redis, чтобы кнопки не умирали.
 */
@Injectable()
export class VideoSessionService {
  private readonly logger = new Logger(VideoSessionService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
  ) {}

  /**
   * Сохранить сессию. Redis обязателен, Postgres — по возможности:
   * если резервная запись не удалась, кнопки всё равно будут работать сутки.
   */
  async save(sessionId: string, videoInfo: VideoInfoDto): Promise<void> {
    await this.redis.setJson(
      REDIS_KEYS.videoSession(sessionId),
      videoInfo,
      REDIS_TTL.videoSession,
    );

    // В Postgres кладём только сессии с выбором качества: для прямых загрузок
    // (Reels / Shorts) кнопок нет, и резервная копия там ни к чему
    if (!videoInfo.formats?.length) return;

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    try {
      await this.prisma.videoSession.create({
        data: {
          id: sessionId,
          originalUrl: videoInfo.url || '',
          videoId: videoInfo.id,
          title: videoInfo.title,
          uploader: videoInfo.uploader,
          duration: videoInfo.duration,
          viewCount: videoInfo.viewCount ? BigInt(videoInfo.viewCount) : null,
          likeCount: videoInfo.likeCount ? BigInt(videoInfo.likeCount) : null,
          uploadDate: videoInfo.uploadDate,
          thumbnail: videoInfo.thumbnail,
          formats: JSON.stringify(videoInfo.formats),
          expiresAt,
        },
      });
    } catch (error: any) {
      // Не пробрасываем: Redis уже принял данные, бот работоспособен
      this.logger.warn(
        `⚠️ Резервная запись сессии не удалась: ${error.message}`,
      );
    }
  }

  /**
   * Получить сессию: сперва Redis, затем Postgres.
   *
   * ⚠️ У записи из Postgres нет directUrl и entries — они нужны только прямым
   * загрузкам, а те живут исключительно в Redis и до этой ветки не доходят.
   */
  async get(sessionId: string): Promise<VideoInfoDto | null> {
    const cached = await this.redis.getJson<VideoInfoDto>(
      REDIS_KEYS.videoSession(sessionId),
    );
    if (cached) return cached;

    try {
      const session = await this.prisma.videoSession.findUnique({
        where: { id: sessionId },
      });

      if (!session) return null;

      if (new Date() > session.expiresAt) {
        await this.delete(sessionId);
        return null;
      }

      const restored: VideoInfoDto = {
        id: session.videoId,
        url: session.originalUrl,
        title: session.title,
        uploader: session.uploader || '',
        duration: session.duration || 0,
        viewCount: session.viewCount ? Number(session.viewCount) : 0,
        likeCount: session.likeCount ? Number(session.likeCount) : 0,
        uploadDate: session.uploadDate || '',
        thumbnail: session.thumbnail || '',
        width: 0,
        height: 0,
        formats: JSON.parse(session.formats as string),
      };

      // Поднимаем обратно в Redis: следующее нажатие кнопки обойдётся без БД
      await this.redis.setJson(
        REDIS_KEYS.videoSession(sessionId),
        restored,
        REDIS_TTL.videoSession,
      );

      return restored;
    } catch (error: any) {
      this.logger.error(`❌ Ошибка получения сессии: ${error.message}`);
      return null;
    }
  }

  async delete(sessionId: string): Promise<void> {
    await this.redis.del(REDIS_KEYS.videoSession(sessionId));

    try {
      await this.prisma.videoSession.delete({ where: { id: sessionId } });
    } catch (error: any) {
      // P2025 — записи уже нет, это нормальный исход
      if (error.code !== 'P2025') {
        this.logger.error(`❌ Ошибка удаления сессии: ${error.message}`);
      }
    }
  }

  /** 🧹 Очистка истёкших сессий в Postgres (в Redis их убирает TTL) */
  async cleanExpired(): Promise<number> {
    try {
      const result = await this.prisma.videoSession.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });

      if (result.count > 0) {
        this.logger.log(`🗑️ Удалено ${result.count} истёкших видео-сессий`);
      }

      return result.count;
    } catch (error: any) {
      this.logger.error(`❌ Ошибка очистки сессий: ${error.message}`);
      return 0;
    }
  }

  async getStats(): Promise<{
    total: number;
    expired: number;
    active: number;
  }> {
    try {
      const now = new Date();
      // Два счётчика одним походом в БД вместо двух последовательных
      const [total, expired] = await this.prisma.$transaction([
        this.prisma.videoSession.count(),
        this.prisma.videoSession.count({ where: { expiresAt: { lt: now } } }),
      ]);

      return { total, expired, active: total - expired };
    } catch (error: any) {
      this.logger.error(`❌ Ошибка получения статистики: ${error.message}`);
      return { total: 0, expired: 0, active: 0 };
    }
  }
}
