// src/modules/downloader/downloader.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Context, InlineKeyboard } from 'grammy';
import * as crypto from 'crypto';
import { CacheService } from '../cache/cache.service';
import { UserService } from '../user/user.service';
import { VideoSessionService } from './video-session/video-session.service';
import { RateLimitService } from './rate-limit.service';
import { MediaDeliveryService } from './media-delivery.service';
import { VideoInfoDto } from './dto/video-info.dto';
import {
  ANALYZE_QUEUE,
  AnalyzeJobData,
  DOWNLOAD_QUEUE,
  DownloadJobData,
} from './interfaces/download-job.interface';
import { isSupportedUrl } from '../../common/constants/platform.constant';
import { formatFileSize } from '../../common/utils/file.utils';
import {
  cleanTitle,
  escapeHtml,
  formatDuration,
  formatNumber,
  formatUploadDate,
} from '../../common/utils/format.utils';

/**
 * 🎬 ПРИЁМ ЗАПРОСОВ ОТ ПОЛЬЗОВАТЕЛЯ
 *
 * Этот сервис живёт на стороне бота и намеренно НЕ делает тяжёлой работы:
 * он проверяет ссылку, применяет лимиты и ставит задачу в очередь. Всё
 * остальное — разбор ссылки, скачивание, перекодировка — происходит в
 * воркерах, которые можно масштабировать репликами.
 */
@Injectable()
export class DownloaderService {
  private readonly logger = new Logger(DownloaderService.name);
  private readonly maxQueueSize: number;

  /** Прямые загрузки (Reels / Shorts) кешируются под фиксированным ключом */
  static readonly DIRECT_FORMAT_ID = 'best';
  static readonly DIRECT_RESOLUTION = 'best';

  constructor(
    @InjectQueue(ANALYZE_QUEUE) private readonly analyzeQueue: Queue,
    @InjectQueue(DOWNLOAD_QUEUE) private readonly downloadQueue: Queue,
    private readonly cacheService: CacheService,
    private readonly userService: UserService,
    private readonly videoSessionService: VideoSessionService,
    private readonly rateLimitService: RateLimitService,
    private readonly media: MediaDeliveryService,
    config: ConfigService,
  ) {
    this.maxQueueSize = config.get<number>('MAX_QUEUE_SIZE') ?? 500;
  }

  /**
   * 🔍 ПРИЁМ ССЫЛКИ
   */
  async handleUrl(ctx: Context, url: string): Promise<void> {
    if (!ctx.chat) {
      await ctx.reply('Данная команда доступна только в чатах.');
      return;
    }

    const rejection = this.rejectUnsupported(url);
    if (rejection) {
      await ctx.reply(rejection);
      return;
    }

    const chatId = ctx.chat.id;
    const userId = ctx.from ? BigInt(ctx.from.id) : 0n;

    // 🛡️ Лимиты на пользователя: минутное и часовое окно плюс потолок
    // одновременных анализов. Без них один человек занимал всю очередь.
    if (userId > 0n) {
      const verdict = await this.rateLimitService.checkAndConsume(userId);
      if (!verdict.allowed) {
        await ctx.reply(verdict.reason || '⏳ Слишком часто, подожди немного.');
        return;
      }
    }

    // 🚧 Общий потолок очереди: при перегрузке честно говорим об этом,
    // вместо того чтобы копить задачи, до которых руки дойдут через час
    if (await this.isOverloaded()) {
      await ctx.reply(
        '🔥 Сейчас очень много запросов, и я не успеваю.\n\n' +
          'Попробуй, пожалуйста, через несколько минут.',
      );
      return;
    }

    const progressMsg = await ctx.reply('🔍 Анализирую ссылку...');

    const jobData: AnalyzeJobData = {
      chatId,
      userId: userId.toString(),
      url,
      progressMsgId: progressMsg.message_id,
    };

    try {
      await this.analyzeQueue.add('analyze', jobData, {
        // Анализ не повторяем: почти все его ошибки постоянные (видео удалено,
        // приватный аккаунт), а повтор означал бы второе сообщение пользователю
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: 100,
      });

      if (userId > 0n) {
        await this.rateLimitService.markAnalysisStarted(userId);
      }
    } catch (error: any) {
      this.logger.error(
        `❌ Не удалось поставить анализ в очередь: ${error.message}`,
      );
      await this.media.editMessage(
        chatId,
        progressMsg.message_id,
        '❌ Сервис временно недоступен. Попробуй через минуту.',
      );
    }
  }

  /**
   * 🎯 ВЫБОР КАЧЕСТВА
   */
  async handleQualitySelection(
    ctx: Context,
    sessionId: string,
    formatId: string,
    resolution: string,
  ): Promise<void> {
    if (!ctx.chat || !ctx.from) return;

    const chatId = ctx.chat.id;
    const userId = BigInt(ctx.from.id);
    const isAudio = resolution === 'audio';

    const videoData = await this.videoSessionService.get(sessionId);

    if (!videoData) {
      await ctx.answerCallbackQuery({
        text: '❌ Данные устарели. Пришли ссылку заново.',
        show_alert: true,
      });
      return;
    }

    // ⚡ Уже качали это видео в этом качестве — отдаём мгновенно
    const cached = await this.cacheService.get(
      videoData.id,
      formatId,
      resolution,
    );

    if (cached) {
      await ctx
        .answerCallbackQuery({ text: '⚡ Мгновенно из кеша!' })
        .catch(() => {});

      const delivered = await this.media.deliverFromCache(
        chatId,
        userId,
        cached,
        videoData,
        { isAudio, resolution },
      );

      if (delivered) return;
      // file_id протух — проваливаемся в обычную загрузку
    }

    await ctx
      .answerCallbackQuery({
        text: '📥 Добавлено в очередь!\n⏳ Пришлю, как только будет готово.',
      })
      .catch(() => {});

    if (await this.isOverloaded()) {
      await this.media.sendMessage(
        chatId,
        '🔥 Сейчас очень много запросов. Попробуй, пожалуйста, через несколько минут.',
      );
      return;
    }

    const progressMsgId = await this.media.sendMessage(
      chatId,
      '📥 Видео в очереди!\n⏳ Я пришлю его, как только оно будет готово.',
    );

    const jobData: DownloadJobData = {
      chatId,
      userId: userId.toString(),
      sessionId,
      isDirect: false,
      isInstagram: false,
      formatId,
      resolution,
      isAudio,
      progressMsgId,
    };

    await this.downloadQueue.add('download', jobData, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      // Провалившиеся задачи раньше копились в Redis без ограничений
      removeOnFail: 500,
    });
  }

  /**
   * ⌨️ КЛАВИАТУРА ВЫБОРА КАЧЕСТВА
   *
   * Вызывается воркером после анализа. Возвращает готовые клавиатуру и текст.
   */
  async buildQualityKeyboard(
    sessionId: string,
    videoInfo: VideoInfoDto,
    isYouTube: boolean,
  ): Promise<{ keyboard: InlineKeyboard; caption: string } | null> {
    const visibleFormats = this.selectVisibleFormats(videoInfo, isYouTube);
    if (visibleFormats.length === 0) return null;

    // ⚡ Одним запросом узнаём, какие форматы уже есть в кеше.
    // Раньше здесь был отдельный SELECT на каждый формат — 5-8 запросов
    // к Postgres ради значков в подписях кнопок.
    const cachedVariants = await this.cacheService.getCachedVariants(
      videoInfo.id,
      visibleFormats.map((f) => ({
        formatId: f.formatId,
        resolution: f.resolution,
      })),
    );

    const keyboard = new InlineKeyboard();

    visibleFormats.forEach((format, index) => {
      const isCached = cachedVariants.has(
        `${format.formatId}|${format.resolution}`,
      );
      const sizeText = format.filesize
        ? formatFileSize(format.filesize)
        : '~ MB';
      const bolt = isCached ? '⚡ ' : '';

      const label =
        format.resolution === 'audio'
          ? `${bolt}🎵 Аудио • ${sizeText}`
          : `${bolt}🎥 ${format.resolution} • ${sizeText}`;

      const text =
        index === 0 && format.resolution !== 'audio' ? `⭐ ${label}` : label;

      keyboard
        .text(text, `dl|${sessionId}|${format.formatId}|${format.resolution}`)
        .row();
    });

    return { keyboard, caption: this.formatVideoCaption(videoInfo) };
  }

  /**
   * 📊 СТАТИСТИКА ДЛЯ АДМИНКИ
   */
  async getStats() {
    const [analyzeWaiting, analyzeActive, downloadWaiting, downloadActive] =
      await Promise.all([
        this.analyzeQueue.getWaitingCount().catch(() => 0),
        this.analyzeQueue.getActiveCount().catch(() => 0),
        this.downloadQueue.getWaitingCount().catch(() => 0),
        this.downloadQueue.getActiveCount().catch(() => 0),
      ]);

    const [cacheStats, userStats] = await Promise.all([
      this.cacheService.getStats(),
      this.userService.getStats(),
    ]);

    return {
      activeDownloads: downloadActive,
      queueSize: downloadWaiting + analyzeWaiting,
      analyzing: analyzeActive,
      cacheSize: cacheStats.totalFiles,
      totalUsers: userStats.totalUsers,
      activeToday: userStats.activeToday,
    };
  }

  /** Новый идентификатор сессии для связки «ссылка → кнопки» */
  createSessionId(): string {
    return crypto.randomBytes(8).toString('hex');
  }

  // ==================== ВНУТРЕННЕЕ ====================

  /**
   * Ссылка заведомо не будет обработана? Вернём текст отказа, иначе null.
   * Проверки дешёвые и делаются до очереди — пользователь получает ответ сразу.
   */
  private rejectUnsupported(url: string): string | null {
    if (url.includes('instagram.com/stories/')) {
      return '🚫 Instagram Stories скачать нельзя.\n\nПопробуй Reels.';
    }

    const isInstagram = url.includes('instagram.com');
    const isInstagramVideo =
      url.includes('/reel/') ||
      url.includes('/reels/') ||
      url.includes('/tv/') ||
      url.includes('/p/');

    if (isInstagram && !isInstagramVideo) {
      return '📷 Я качаю только видео (Reels).\n\nФото и карусели не поддерживаю.';
    }

    if (!isSupportedUrl(url)) {
      return '❌ Эта платформа не поддерживается.\n\nРаботаю с YouTube и Instagram.';
    }

    return null;
  }

  /** Очередь переполнена? */
  private async isOverloaded(): Promise<boolean> {
    try {
      const [analyzeWaiting, downloadWaiting] = await Promise.all([
        this.analyzeQueue.getWaitingCount(),
        this.downloadQueue.getWaitingCount(),
      ]);

      return analyzeWaiting + downloadWaiting >= this.maxQueueSize;
    } catch (error: any) {
      // Redis недоступен — не блокируем пользователей, задача всё равно
      // не поставится и он получит внятную ошибку ниже
      this.logger.warn(`⚠️ Не удалось измерить очередь: ${error.message}`);
      return false;
    }
  }

  /**
   * Отбор форматов для клавиатуры: видео в разумных пределах разрешения,
   * от большего к меньшему, плюс аудио в конце.
   */
  private selectVisibleFormats(videoInfo: VideoInfoDto, isYouTube: boolean) {
    const MAX_RESOLUTION = isYouTube ? 1080 : 4320;
    const MIN_RESOLUTION = 360;

    const all = videoInfo.formats || [];
    const audioFormat = all.find((f) => f.resolution === 'audio');

    const videoFormats = all
      .filter((format) => {
        if (format.resolution === 'audio') return false;
        const height = parseInt(format.resolution, 10);
        return (
          !isNaN(height) && height >= MIN_RESOLUTION && height <= MAX_RESOLUTION
        );
      })
      .sort(
        (a, b) =>
          (parseInt(b.resolution, 10) || 0) - (parseInt(a.resolution, 10) || 0),
      );

    // Ничего не прошло по фильтру — показываем что есть, лишь бы не отказ
    const visible =
      videoFormats.length > 0
        ? videoFormats
        : all.filter((f) => f.resolution !== 'audio');

    if (audioFormat) visible.push(audioFormat);
    return visible;
  }

  /** Карточка видео над кнопками выбора качества */
  private formatVideoCaption(info: VideoInfoDto): string {
    return (
      `🎬 <b>${cleanTitle(info.title)}</b>\n\n` +
      `👁 ${formatNumber(info.viewCount)} • 👍 ${formatNumber(info.likeCount)}\n` +
      `📥 ${formatUploadDate(info.uploadDate)}\n` +
      `👤 ${escapeHtml(info.uploader || '—')}\n` +
      `🕒 ${formatDuration(info.duration)}\n\n` +
      `<b>📌 Выберите качество:</b>`
    );
  }
}
