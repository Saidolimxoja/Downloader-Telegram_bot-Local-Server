// src/modules/downloader/analysis.service.ts

import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Bot, Context } from 'grammy';
import { TELEGRAM_BOT } from '../telegram/telegram.module';
import { YtdlpService } from '../ytdlp/ytdlp.service';
import { CacheService } from '../cache/cache.service';
import { VideoSessionService } from './video-session/video-session.service';
import { MediaDeliveryService } from './media-delivery.service';
import { RateLimitService } from './rate-limit.service';
import { DownloaderService } from './downloader.service';
import {
  AnalyzeJobData,
  DOWNLOAD_QUEUE,
  DownloadJobData,
} from './interfaces/download-job.interface';

/**
 * 🔍 РАЗБОР ССЫЛКИ (сторона воркера)
 *
 * Самая тяжёлая по памяти операция во всём боте: каждый вызов yt-dlp — это
 * процесс Python на 60-120 МБ. Раньше он запускался прямо в обработчике
 * сообщения, без какого-либо потолка: двести человек, приславших ссылку
 * одновременно, поднимали двести процессов и укладывали сервер.
 *
 * Теперь разбор идёт через очередь с фиксированной конкурентностью, а её
 * размер настраивается под мощность машины.
 */
@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);

  constructor(
    @Inject(TELEGRAM_BOT) private readonly bot: Bot<Context>,
    @InjectQueue(DOWNLOAD_QUEUE) private readonly downloadQueue: Queue,
    private readonly ytdlpService: YtdlpService,
    private readonly cacheService: CacheService,
    private readonly videoSessionService: VideoSessionService,
    private readonly media: MediaDeliveryService,
    private readonly rateLimitService: RateLimitService,
    private readonly downloaderService: DownloaderService,
  ) {}

  async analyze(data: AnalyzeJobData): Promise<void> {
    const { chatId, url, progressMsgId } = data;
    const userId = BigInt(data.userId);

    try {
      const info = await this.ytdlpService.getVideoInfo(url);

      const isYouTube = url.includes('youtube.com') || url.includes('youtu.be');
      const isInstagram = url.includes('instagram.com');
      const isShorts = url.includes('/shorts/');

      const sessionId = this.downloaderService.createSessionId();
      await this.videoSessionService.save(sessionId, info);

      // Короткие видео уходят на загрузку сразу, без выбора качества
      if (isInstagram || isShorts) {
        await this.routeDirectDownload(
          data,
          sessionId,
          info,
          isInstagram,
          userId,
        );
        return;
      }

      await this.showQualityKeyboard(data, sessionId, info, isYouTube);
    } catch (error: any) {
      await this.media.editMessage(
        chatId,
        progressMsgId,
        this.explainError(error),
      );
      this.logger.warn(`⚠️ Анализ ${url}: ${error.message?.substring(0, 200)}`);
    } finally {
      // Слот пользователя освобождаем при любом исходе, иначе после первой
      // же ошибки он остался бы заблокированным до истечения TTL
      if (userId > 0n) {
        await this.rateLimitService.markAnalysisFinished(userId);
      }
    }
  }

  // ==================== МАРШРУТИЗАЦИЯ ====================

  /** Прямая загрузка: проверяем кеш и, если промах, ставим в очередь */
  private async routeDirectDownload(
    data: AnalyzeJobData,
    sessionId: string,
    info: any,
    isInstagram: boolean,
    userId: bigint,
  ): Promise<void> {
    const cached = await this.cacheService.get(
      info.id,
      DownloaderService.DIRECT_FORMAT_ID,
      DownloaderService.DIRECT_RESOLUTION,
    );

    if (cached) {
      const delivered = await this.media.deliverFromCache(
        data.chatId,
        userId,
        cached,
        info,
      );

      if (delivered) {
        await this.media.deleteMessage(data.chatId, data.progressMsgId);
        return;
      }
    }

    const jobData: DownloadJobData = {
      chatId: data.chatId,
      userId: data.userId,
      sessionId,
      isDirect: true,
      isInstagram,
      progressMsgId: data.progressMsgId,
    };

    await this.downloadQueue.add('download', jobData, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: 500,
      priority: await this.downloaderService.resolvePriority(userId),
    });

    await this.media.editMessage(
      data.chatId,
      data.progressMsgId,
      '📥 Видео в очереди!\n⏳ Я пришлю его, как только оно будет готово.',
    );
  }

  /** Показ карточки видео с кнопками выбора качества */
  private async showQualityKeyboard(
    data: AnalyzeJobData,
    sessionId: string,
    info: any,
    isYouTube: boolean,
  ): Promise<void> {
    const built = await this.downloaderService.buildQualityKeyboard(
      sessionId,
      info,
      isYouTube,
    );

    if (!built) {
      await this.media.editMessage(
        data.chatId,
        data.progressMsgId,
        '❌ Нет доступных форматов для скачивания.',
      );
      return;
    }

    // Пробуем показать превью с кнопками. Если картинка недоступна —
    // остаёмся на текстовом сообщении, которое уже висит в чате.
    if (info.thumbnail) {
      try {
        await this.bot.api.sendPhoto(data.chatId, info.thumbnail, {
          caption: built.caption,
          parse_mode: 'HTML',
          reply_markup: built.keyboard,
        });

        await this.media.deleteMessage(data.chatId, data.progressMsgId);
        return;
      } catch (error: any) {
        this.logger.debug(`Превью не отправилось: ${error.message}`);
      }
    }

    await this.bot.api
      .editMessageText(data.chatId, data.progressMsgId, built.caption, {
        parse_mode: 'HTML',
        reply_markup: built.keyboard,
      })
      .catch(() => {});
  }

  // ==================== ОШИБКИ ====================

  /**
   * Превращаем сообщение yt-dlp в человеческое объяснение.
   * Пользователю бесполезен стектрейс — ему нужно понять, что делать дальше.
   */
  private explainError(error: Error): string {
    const text = (error.message || '').toLowerCase();

    if (
      text.includes('you need to log in') ||
      text.includes('login required')
    ) {
      return '🔒 Это приватный контент (Stories или закрытый аккаунт).\nБот не может его скачать.';
    }

    if (text.includes('video unavailable') || text.includes('removed')) {
      return '❌ Видео недоступно или удалено.';
    }

    if (text.includes('private video')) {
      return '🔒 Видео приватное, доступ закрыт.';
    }

    if (text.includes('age')) {
      return '🔞 Видео ограничено по возрасту, бот не может его скачать.';
    }

    if (text.includes('timed out') || text.includes('timeout')) {
      return '⏱ Площадка слишком долго не отвечает. Попробуй ещё раз.';
    }

    if (text.includes('not available in your country')) {
      return '🌍 Видео недоступно в стране, где стоит сервер.';
    }

    return '❌ Не удалось проанализировать ссылку.\nВозможно, видео недоступно или ссылка неверна.';
  }
}
