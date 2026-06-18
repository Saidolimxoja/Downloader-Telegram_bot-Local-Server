// src/modules/downloader/downloader.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Context, InlineKeyboard, Bot, InputFile } from 'grammy';
import { YtdlpService } from '../ytdlp/ytdlp.service';
import { QueueService } from './queue.service';
import { CacheService } from '../cache/cache.service';
import { UploaderService } from '../uploader/uploader.service';
import { UserService } from '../user/user.service';
import { VideoInfoDto } from './dto/video-info.dto';
import {
  formatDuration,
  formatNumber,
  formatUploadDate,
  createProgressBar,
} from '../../common/utils/format.utils';
import {
  sanitizeFilename,
  formatFileSize,
} from '../../common/utils/file.utils';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs/promises';
import { AdvertisementService } from '../advertisement/advertisement.service';
import { VideoSessionService } from './video-session/video-session.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InjectBot } from '@grammyjs/nestjs';
@Injectable()
export class DownloaderService {
  private readonly logger = new Logger(DownloaderService.name);
  private videoDataCache = new Map<string, VideoInfoDto>();
  private activeDownloads = new Map<string, Promise<void>>();
  // 🛡️ Пользователи, у которых сейчас обрабатывается ссылка (антиспам)
  private activeUsers = new Set<string>();
  private readonly downloadsDir: string;
  private readonly yourUsername: string;

  // Ограничение памяти для videoDataCache (защита от утечки)
  private static readonly MAX_VIDEO_CACHE = 500;
  // Ключи кеша для прямых загрузок (Instagram / YouTube Shorts) — всегда лучшее качество
  private static readonly DIRECT_FORMAT_ID = 'best';
  private static readonly DIRECT_RESOLUTION = 'best';

  constructor(
    @InjectQueue('download-queue') private downloadQueue: Queue,
    private ytdlpService: YtdlpService,
    private queueService: QueueService,
    private cacheService: CacheService,
    private uploaderService: UploaderService,
    private userService: UserService,
    private config: ConfigService,
    private advertisementService: AdvertisementService,
    private videoSessionService: VideoSessionService,
    @InjectBot() private readonly bot: Bot<Context>,
  ) {
    this.downloadsDir =
      this.config.get<string>('DOWNLOADS_DIR') || '/tmp/bot_downloads';
    this.yourUsername = this.config.get<string>('YOUR_USERNAME') || '@your_bot';

    this.ensureDirectoryExists();
  }

  private async ensureDirectoryExists() {
    try {
      await fs.mkdir(this.downloadsDir, { recursive: true });
    } catch (err: any) {
      this.logger.error(
        `Не удалось создать папку для скачивания: ${err.message}`,
      );
    }
  }

  /**
   * 🔍 ОБРАБОТКА URL
   */
  async handleUrl(ctx: Context, url: string): Promise<void> {
    if (!ctx.chat) {
      await ctx.reply('Данная команда доступна только в чатах.');
      return;
    }

    const chatId = ctx.chat.id;
    let progressMsg;
    if (url.includes('instagram.com/stories/')) {
      await ctx.reply(
        '🚫 Instagram Stories скачать нельзя.\n\nПопробуй Reels.',
      );
      return;
    }

    // Instagram фото / карусели — бот качает только видео (Reels)
    if (
      url.includes('instagram.com') &&
      !url.includes('/reel/') &&
      !url.includes('/reels/') &&
      !url.includes('/tv/')
    ) {
      await ctx.reply(
        '📷 Я качаю только видео (Reels).\n\nФото и карусели не поддерживаю.',
      );
      return;
    }
    const supportedDomains = ['youtube.com', 'youtu.be', 'instagram.com'];
    const isSupported = supportedDomains.some((domain) => url.includes(domain));
    if (!isSupported) {
      await ctx.reply(
        '❌ Эта платформа не поддерживается.\n\nРаботаю с YouTube, Instagram',
      );
      return;
    }

    // 🛡️ Антиспам: одна ссылка на пользователя за раз
    const userKey = ctx.from ? ctx.from.id.toString() : null;
    if (userKey && this.activeUsers.has(userKey)) {
      await ctx.reply(
        '⏳ Подожди, я ещё обрабатываю твою предыдущую ссылку...',
      );
      return;
    }
    if (userKey) this.activeUsers.add(userKey);

    try {
      progressMsg = await ctx.reply('🔍 Анализирую ссылку...');

      const videoInfo = await this.ytdlpService.getVideoInfo(url);

      const isYouTube = url.includes('youtube.com') || url.includes('youtu.be');
      const isInstagram = url.includes('instagram.com');
      const isYouTubeShorts = url.includes('/shorts/');

      const userId = ctx.from ? BigInt(ctx.from.id) : BigInt(0);

      // Instagram и YouTube Shorts — скачиваем сразу в максимальном качестве,
      // без выбора качества
      if (isInstagram || isYouTubeShorts) {
        await ctx.api
          .deleteMessage(chatId, progressMsg.message_id)
          .catch(() => {});

        // ⚡ Быстрый путь: если видео уже в кеше — отдаём мгновенно, минуя очередь
        const cached = await this.cacheService.get(
          videoInfo.id,
          DownloaderService.DIRECT_FORMAT_ID,
          DownloaderService.DIRECT_RESOLUTION,
        );

        if (cached) {
          try {
            await ctx.replyWithVideo(cached.fileId, {
              caption: `✅ ${videoInfo.title}\n\n📢 ${this.yourUsername}`,
              supports_streaming: true,
            });
            await this.cacheService
              .recordCacheHit(cached.id, userId)
              .catch(() => {});
            await this.userService.incrementDownloads(userId).catch(() => {});
            this.advertisementService.incrementUserDownloads(userId);
            return;
          } catch (e) {
            const err = e as Error;
            this.logger.warn(
              `⚠️ FileID из кеша протух, ставлю в очередь: ${err.message}`,
            );
          }
        }

        // Сначала отправляем уведомление, чтобы получить его message_id —
        // воркер переиспользует это сообщение под прогресс и удалит его, когда
        // видео отправлено (одно «живое» сообщение вместо висящего навсегда).
        const queueMsg = await ctx.reply(
          '📥 Видео добавлено в очередь!\n⏳ Я пришлю его, как только оно будет готово.',
        );

        // Иначе — в очередь (НЕ блокируем бота на время скачивания)
        await this.downloadQueue.add(
          'download-task',
          {
            chatId,
            userId: userId.toString(),
            videoData: videoInfo,
            isDirect: true,
            isInstagram,
            queueMsgId: queueMsg.message_id,
          },
          {
            attempts: 3,
            backoff: 5000,
            removeOnComplete: true,
          },
        );
        return;
      }

      const sessionId = crypto.randomBytes(8).toString('hex');

      this.cacheVideoData(sessionId, videoInfo);
      await this.videoSessionService.save(sessionId, videoInfo);

      const MAX_RESOLUTION = isYouTube ? 1080 : isInstagram ? 1080 : 4320;
      const MIN_RESOLUTION = 360;
      // 1. Фильтруем и разделяем
      const allFormats = videoInfo.formats;

      const audioFormat = allFormats.find((f) => f.resolution === 'audio');

      const videoFormats = allFormats
        .filter((format) => {
          if (format.resolution === 'audio') return false;
          const height = parseInt(format.resolution, 10);
          return (
            !isNaN(height) &&
            height >= MIN_RESOLUTION &&
            height <= MAX_RESOLUTION
          );
        })
        .sort((a, b) => {
          const hA = parseInt(a.resolution, 10) || 0;
          const hB = parseInt(b.resolution, 10) || 0;
          return hB - hA;
        });

      // 2. Собираем финальный порядок: лучшие видео → ... → аудио (если есть)
      const visibleFormats = [...videoFormats];
      if (audioFormat) {
        visibleFormats.push(audioFormat);
      }

      // 3. Если ничего не осталось — можно добавить обработку
      if (visibleFormats.length === 0) {
        const fallbackFormats = allFormats.filter(
          (f) => f.resolution !== 'audio',
        );
        visibleFormats.push(...fallbackFormats);
        if (audioFormat) visibleFormats.push(audioFormat);
      }

      if (visibleFormats.length === 0) {
        await ctx.api
          .deleteMessage(chatId, progressMsg.message_id)
          .catch(() => {});
        await ctx.reply('❌ Нет доступных форматов для скачивания.');
        return;
      }

      // 4. Создаём клавиатуру
      const keyboard = new InlineKeyboard();

      const cacheChecks = await Promise.allSettled(
        visibleFormats.map((format) =>
          this.cacheService
            .get(videoInfo.id, format.formatId, format.resolution)
            .then((result) => !!result)
            .catch(() => false),
        ),
      );

      visibleFormats.forEach((format, idx) => {
        const key = `${sessionId}|${format.formatId}|${format.resolution}`;
        const sizeText = format.filesize
          ? formatFileSize(format.filesize)
          : '~ MB';

        const isCached =
          cacheChecks[idx].status === 'fulfilled' && cacheChecks[idx].value === true;
        const cacheIcon = isCached ? '⚡' : '';

        const label =
          format.resolution === 'audio'
            ? `🎵 Аудио • ${sizeText}${isCached ? ' ⚡' : ''}`
            : `${cacheIcon} 🎥 ${format.resolution} • ${sizeText}`.trim();

        const buttonText =
          idx === 0 && format.resolution !== 'audio' ? `⭐ ${label}` : label;

        keyboard.text(buttonText, `dl|${key}`).row();
      });

      // 🔥 НОВОЕ: Форматируем caption с нормальным названием
      const caption = this.formatVideoCaption(videoInfo);

      // 🔥 ОТПРАВЛЯЕМ С ПРЕВЬЮ ВМЕСТО ТЕКСТА
      if (videoInfo.thumbnail) {
        try {
          // Удаляем старое текстовое сообщение
          await ctx.api
            .deleteMessage(chatId, progressMsg.message_id)
            .catch(() => {});

          // Отправляем фото с превью
          await ctx.replyWithPhoto(videoInfo.thumbnail, {
            caption: caption,
            parse_mode: 'HTML',
            reply_markup: keyboard,
          });
        } catch (photoError) {
          // Если превью не загрузилось, отправляем текстом
          this.logger.warn('⚠️ Не удалось загрузить превью, отправляю текстом');
          await ctx.api.editMessageText(
            chatId,
            progressMsg.message_id,
            caption,
            { parse_mode: 'HTML', reply_markup: keyboard },
          );
        }
      } else {
        // Нет превью - отправляем текстом
        await ctx.api.editMessageText(chatId, progressMsg.message_id, caption, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
      }
    } catch (error: any) {
      this.logger.error('Ошибка анализа видео', error);

      let errorMsg =
        '❌ Не удалось проанализировать ссылку.\nВозможно, видео недоступно или слишком длинное.';

      if (error.message?.includes('You need to log in')) {
        errorMsg =
          '🔒 Это приватный контент (Stories или закрытый аккаунт).\nБот не может его скачать.';
      } else if (error.message?.includes('Video unavailable')) {
        errorMsg = '❌ Видео недоступно или удалено.';
      } else if (error.message?.includes('Private video')) {
        errorMsg = '🔒 Видео приватное, доступ закрыт.';
      } else if (error.message?.includes('age')) {
        errorMsg = '🔞 Видео ограничено по возрасту, бот не может его скачать.';
      }

      if (progressMsg) {
        await ctx.api
          .editMessageText(chatId, progressMsg.message_id, errorMsg)
          .catch(() => {});
      } else {
        await ctx.reply(errorMsg);
      }
    } finally {
      // 🛡️ Снимаем блокировку пользователя в любом случае
      if (userKey) this.activeUsers.delete(userKey);
    }
  }
  /**
   * 🎯 ОБРАБОТКА ВЫБОРА КАЧЕСТВА
   */
  async handleQualitySelection(
    ctx: Context,
    bot: Bot<Context>,
    videoId: string,
    formatId: string,
    resolution: string,
  ): Promise<void> {
    if (!ctx.chat || !ctx.from) return;
    const userId = BigInt(ctx.from.id);

    // Получаем данные видео
    const videoData =
      this.videoDataCache.get(videoId) ||
      (await this.videoSessionService.get(videoId));

    if (!videoData) {
      await ctx.answerCallbackQuery({ text: '❌ Ошибка: данные не найдены.' });
      return;
    }

    // Проверяем кеш
    const cached = await this.cacheService.get(
      videoData.id,
      formatId,
      resolution,
    );

    if (cached) {
      this.logger.log(`🎯 Cache HIT: ${videoData.id} [${resolution}]`);

      // 1. Отвечаем на кнопку сразу
      await ctx
        .answerCallbackQuery({
          text: '⚡ Мгновенно из кеша!',
          show_alert: false,
        })
        .catch(() => {});

      const isAudio = resolution === 'audio';
      const caption =
        `${isAudio ? '🎵' : '🎬'} <b>${this.escapeHtml(videoData.title)}</b>\n\n` +
        `📥 Качество: <b>${resolution}</b>\n` +
        `📢 ${this.yourUsername}`;

      try {
        // 2. Отправляем файл пользователю по fileId
        if (isAudio) {
          await ctx.replyWithAudio(cached.fileId, {
            caption,
            parse_mode: 'HTML',
            title: videoData.title,
            performer: videoData.uploader || undefined,
          });
        } else {
          await ctx.replyWithVideo(cached.fileId, {
            caption,
            parse_mode: 'HTML',
            supports_streaming: true,
          });
        }

        // 3. ОБЯЗАТЕЛЬНО: Обновляем статистику для кешированной загрузки
        const userId = BigInt(ctx.from.id);
        await this.cacheService
          .recordCacheHit(cached.id, userId)
          .catch(() => {});
        await this.userService.incrementDownloads(userId).catch(() => {});

        // 4. Проверяем рекламу (даже при кеше мы должны её показывать)
        this.advertisementService.incrementUserDownloads(userId);
        if (await this.advertisementService.shouldShowAd(userId)) {
          await this.advertisementService.showAd(ctx).catch(() => {});
        }

        return; // Завершаем метод, в очередь BullMQ задание не пойдет
      } catch (e) {
        const error = e as Error;
        this.logger.warn(
          `⚠️ FileID протух или ошибка отправки из кеша, переходим к скачиванию: ${error.message}`,
        );
      }
    }

    // Проверка дубликатов загрузок
    const downloadKey = `${videoData.id}|${formatId}`;
    if (this.activeDownloads.has(downloadKey)) {
      await ctx.answerCallbackQuery({ text: '⏳ Уже скачивается, ждите...' });
      return;
    }

    await ctx.answerCallbackQuery({
      text:
        '📥 Добавлено в очередь загрузки!\n' +
        '⏳ Я пришлю видео, как только оно будет готово.',
    });

    // Добавляем в очередь
    await this.downloadQueue.add(
      'download-task',
      {
        chatId: ctx.chat.id,
        userId: userId.toString(),
        videoData,
        formatId,
        resolution,
        isAudio: resolution === 'audio',
        isInstagram: false,
      },
      {
        attempts: 3, // Если упадет, попробовать еще 3 раза
        backoff: 5000, // Пауза между попытками 5 сек
        removeOnComplete: true, // Удалять из Redis после успеха
      },
    );
  }

  /**
   * 📥 ПРОЦЕСС СКАЧИВАНИЯ И ЗАГРУЗКИ
   */
  async executeDownloadLogic(
    chatId: number,
    userId: bigint,
    videoData: VideoInfoDto,
    formatId: string,
    resolution: string,
    isAudio: boolean,
    isInstagram: boolean,
  ): Promise<void> {
    let progressMsg: any;

    try {
      // 1. Отправляем начальное сообщение через bot.api
      progressMsg = await this.bot.api.sendMessage(
        chatId,
        '⬇️ Начинаю загрузку...',
      );

      const sanitizedTitle = sanitizeFilename(videoData.title);
      const fileExt = isAudio ? 'm4a' : 'mp4';
      const filename = `${sanitizedTitle}_${formatId}.${fileExt}`;
      let filepath = path.resolve(this.downloadsDir, filename);

      // YouTube URL или Instagram URL
      const sourceUrl = videoData.url;

      // 2️⃣ СКАЧИВАНИЕ (yt-dlp)
      let lastProgressBucket = -1;
      filepath = await this.ytdlpService.downloadVideo(
        sourceUrl,
        formatId,
        filepath,
        isAudio,
        async (progress) => {
          // Обновляем прогресс раз в 15% — ровно один раз на каждый диапазон,
          // чтобы не словить Flood Limit от Telegram и не было дублей
          const bucket = Math.floor(progress / 15);
          if (bucket === lastProgressBucket) return;
          lastProgressBucket = bucket;

          const bar = createProgressBar(progress);
          await this.bot.api
            .editMessageText(
              chatId,
              progressMsg.message_id,
              `⬇️ Скачивание\n${bar} ${Math.floor(progress)}%`,
            )
            .catch(() => {});
        },
      );

      await this.bot.api
        .editMessageText(
          chatId,
          progressMsg.message_id,
          '📤 Загрузка в Телеграм...',
        )
        .catch(() => {});

      // 3️⃣ ЗАГРУЗКА В АРХИВНЫЙ КАНАЛ
      let uploadResult: { fileId: string; messageId: number };
      try {
        uploadResult = await this.uploaderService.cacheToChannel(
          filepath,
          videoData,
          isAudio,
        );
      } catch (cacheError: any) {
        this.logger.warn(
          `⚠️ Кеш не удался, отправляю напрямую: ${cacheError.message}`,
        );

        // Отправка напрямую (fallback), если канал недоступен
        if (isAudio) {
          await this.bot.api.sendAudio(chatId, new InputFile(filepath), {
            caption: `✅ ${videoData.title}\n\n📥 ${resolution}`,
            title: videoData.title,
            performer: videoData.uploader || undefined,
          });
        } else {
          await this.bot.api.sendVideo(chatId, new InputFile(filepath), {
            caption: `✅ ${videoData.title}\n\n📥 ${resolution}`,
            supports_streaming: true,
          });
        }

        await this.cleanupFiles(filepath);
        await this.bot.api
          .deleteMessage(chatId, progressMsg.message_id)
          .catch(() => {});
        return;
      }

      // 4️⃣ СОХРАНЕНИЕ В КЕШ БД
      await this.saveToCache(
        filepath,
        videoData,
        formatId,
        resolution,
        uploadResult,
        userId,
        isAudio,
      );

      // 5️⃣ ОТПРАВКА ПОЛЬЗОВАТЕЛЮ (по file_id)
      const userCaption = `✅ ${videoData.title}\n\n📥 ${resolution}\n\n📢 ${this.yourUsername}`;

      if (isAudio) {
        await this.bot.api.sendAudio(chatId, uploadResult.fileId, {
          caption: userCaption,
          title: videoData.title,
          performer: videoData.uploader || undefined,
        });
      } else {
        await this.bot.api.sendVideo(chatId, uploadResult.fileId, {
          caption: userCaption,
          supports_streaming: true,
        });
      }

      // 6️⃣ ОЧИСТКА
      await this.bot.api
        .deleteMessage(chatId, progressMsg.message_id)
        .catch(() => {});
      await this.cleanupFiles(filepath);

      // 7️⃣ СТАТИСТИКА
      await this.userService.incrementDownloads(userId);
      this.advertisementService.incrementUserDownloads(userId);
    } catch (error: any) {
      this.logger.error(`Ошибка процесса скачивания: ${error.stack}`);
      if (progressMsg) {
        await this.bot.api
          .editMessageText(
            chatId,
            progressMsg.message_id,
            `❌ Ошибка: ${error.message}`,
          )
          .catch(() => {});
      }
    }
  }

  // Вспомогательный метод для очистки файлов
  private async cleanupFiles(filepath: string) {
    await fs.unlink(filepath).catch(() => {});
    const thumb = this.ytdlpService.getThumbnailPath(filepath);
    if (thumb) await fs.unlink(thumb).catch(() => {});
  }

  /**
   * 💾 Запись в in-memory кеш видео с ограничением размера (защита от утечки памяти).
   * Map сохраняет порядок вставки — при переполнении удаляем самые старые записи.
   */
  private cacheVideoData(sessionId: string, videoInfo: VideoInfoDto): void {
    this.videoDataCache.set(sessionId, videoInfo);

    while (this.videoDataCache.size > DownloaderService.MAX_VIDEO_CACHE) {
      const oldestKey = this.videoDataCache.keys().next().value;
      if (oldestKey === undefined) break;
      this.videoDataCache.delete(oldestKey);
    }
  }

  // Вспомогательный метод для записи в БД
  private async saveToCache(
    filepath: string,
    videoData: any,
    formatId: string,
    resolution: string,
    uploadResult: any,
    userId: bigint,
    isAudio: boolean,
  ) {
    try {
      const fileStats = await fs.stat(filepath).catch(() => ({ size: 0 }));
      await this.cacheService.set({
        url: videoData.id,
        formatId: formatId,
        resolution: resolution,
        fileId: uploadResult.fileId,
        archiveMessageId: uploadResult.messageId,
        fileSize: BigInt(fileStats.size),
        fileType: isAudio ? 'audio' : 'video',
        userId: userId,
        title: videoData.title,
        uploader: videoData.uploader || undefined,
        duration: videoData.duration || undefined,
      });
    } catch (dbError) {
      const error = dbError as Error;
      this.logger.error(`Ошибка сохранения в БД: ${error.message}`);
    }
  }

  /**
   * 🛡️ ЭКРАНИРОВАНИЕ HTML
   */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * 🧹 ОЧИСТКА НАЗВАНИЯ (если еще не добавлен выше)
   */
  private cleanTitle(title: string): string {
    return this.escapeHtml(
      title
        .replace(/_/g, ' ') // _ → пробел
        .replace(/\s+/g, ' ') // множественные пробелы → один
        .trim(),
    );
  }

  /**
   * 📝 ФОРМАТИРОВАНИЕ CAPTION ДЛЯ ВИДЕО (если еще не добавлен выше)
   */
  private formatVideoCaption(info: VideoInfoDto): string {
    const cleanTitle = this.cleanTitle(info.title);
    const uploader = this.escapeHtml(info.uploader || '—');

    return (
      `🎬 <b>${cleanTitle}</b>\n\n` +
      `👁 ${formatNumber(info.viewCount)} • 👍 ${formatNumber(info.likeCount)}\n` +
      `📥 ${formatUploadDate(info.uploadDate)}\n` +
      `👤 ${uploader}\n` +
      `🕒 ${formatDuration(info.duration)}\n\n` +
      `<b>📌 Выберите качество:</b>`
    );
  }

  /**
   * 📊 СТАТИСТИКА
   */
  async getStats() {
    const queueStatus = this.queueService.getStatus();
    const cacheStats = await this.cacheService.getStats();
    const userStats = await this.userService.getStats();

    return {
      activeDownloads: queueStatus.active,
      queueSize: queueStatus.queued,
      cacheSize: cacheStats.totalFiles,
      totalUsers: userStats.totalUsers,
    };
  }

  /**
   * 📥 ПРЯМОЕ СКАЧИВАНИЕ без выбора качества (Instagram + YouTube Shorts).
   * Выполняется в воркере очереди, поэтому работает через this.bot.api + chatId
   * (без ctx) и не блокирует обработку сообщений бота.
   */
  async executeDirectDownloadLogic(
    chatId: number,
    userId: bigint,
    videoInfo: VideoInfoDto,
    isInstagram: boolean,
    queueMsgId?: number,
  ): Promise<void> {
    // Переиспользуем сообщение «📥 в очереди»: оно превратится в прогресс
    // скачивания и будет удалено в конце. Если id не пришёл — создадим новое.
    let progressMsg: any = queueMsgId ? { message_id: queueMsgId } : null;

    try {
      // 1️⃣ ПРОВЕРКА КЕША — на случай, если видео закешировали, пока задача ждала
      // в очереди (популярные Shorts/Reels запрашивают одновременно много людей)
      const cached = await this.cacheService.get(
        videoInfo.id,
        DownloaderService.DIRECT_FORMAT_ID,
        DownloaderService.DIRECT_RESOLUTION,
      );

      if (cached) {
        this.logger.log(`🎯 Cache HIT (direct): ${videoInfo.id}`);
        try {
          await this.bot.api.sendVideo(chatId, cached.fileId, {
            caption: `✅ ${videoInfo.title}\n\n📢 ${this.yourUsername}`,
            supports_streaming: true,
          });
          if (progressMsg) {
            await this.bot.api
              .deleteMessage(chatId, progressMsg.message_id)
              .catch(() => {});
          }
          await this.cacheService
            .recordCacheHit(cached.id, userId)
            .catch(() => {});
          await this.userService.incrementDownloads(userId).catch(() => {});
          this.advertisementService.incrementUserDownloads(userId);
          return;
        } catch (e) {
          const err = e as Error;
          this.logger.warn(
            `⚠️ FileID из кеша протух, скачиваю заново: ${err.message}`,
          );
        }
      }

      // ⚡ URL-DIRECT (только Instagram): отдаём прямую H.264-ссылку Telegram —
      // он сам качает её в архивный канал, наш сервер НЕ качает и НЕ заливает.
      // YouTube сюда не идёт: он привязывает ссылки к IP и троттлит, Telegram их
      // не заберёт. При любой ошибке проваливаемся в обычное скачивание ниже.
      if (isInstagram && videoInfo.directUrl) {
        try {
          if (progressMsg) {
            await this.bot.api
              .editMessageText(
                chatId,
                progressMsg.message_id,
                '⚡ Готовлю видео...',
              )
              .catch(() => {});
          }

          const uploadResult = await this.uploaderService.cacheUrlToChannel(
            videoInfo.directUrl,
            videoInfo,
          );

          await this.bot.api.sendVideo(chatId, uploadResult.fileId, {
            caption: `✅ ${videoInfo.title}\n\n📢 ${this.yourUsername}`,
            supports_streaming: true,
          });

          // Сохраняем в кэш — повторные запросы будут мгновенными (filepath
          // пустой: файла на диске нет, fileSize запишется как 0)
          await this.saveToCache(
            '',
            videoInfo,
            DownloaderService.DIRECT_FORMAT_ID,
            DownloaderService.DIRECT_RESOLUTION,
            uploadResult,
            userId,
            false,
          );

          if (progressMsg) {
            await this.bot.api
              .deleteMessage(chatId, progressMsg.message_id)
              .catch(() => {});
          }

          await this.userService.incrementDownloads(userId).catch(() => {});
          this.advertisementService.incrementUserDownloads(userId);
          this.logger.log(`⚡ URL-direct успех: ${videoInfo.id}`);
          return;
        } catch (e) {
          const err = e as Error;
          this.logger.warn(
            `⚠️ URL-direct не удался, перехожу к скачиванию: ${err.message}`,
          );
          // проваливаемся ниже в обычное скачивание
        }
      }

      if (progressMsg) {
        // Переиспользуем сообщение «в очереди» под прогресс
        await this.bot.api
          .editMessageText(chatId, progressMsg.message_id, '⬇️ Скачиваю видео...')
          .catch(() => {});
      } else {
        progressMsg = await this.bot.api.sendMessage(
          chatId,
          '⬇️ Скачиваю видео...',
        );
      }

      const sanitizedTitle = sanitizeFilename(videoInfo.title);
      const suffix = isInstagram ? 'ig' : 'short';
      const filename = `${sanitizedTitle}_${suffix}.mp4`;
      let filepath = path.resolve(this.downloadsDir, filename);

      // 🚀 Как большие боты отдают reels/shorts за секунду: берут ГОТОВЫЙ
      // прогрессивный файл (видео+звук в одном), который Instagram/YouTube сразу
      // отдают в H.264 — он играет на iPhone и НЕ требует перекода. Гонимся за
      // скоростью, а не за максимальным разрешением. Порядок предпочтений:
      //  1) best — готовый муксированный H.264-файл (мгновенно, без склейки)
      //  2) H.264-видео + AAC-аудио раздельно (склейка без перекода)
      //  3) H.264-видео + любое аудио
      //  4) что угодно (сработает страховочный перекод в ensureIphoneCompatible)
      const iosFormat =
        'best/' +
        'bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/' +
        'bestvideo[vcodec^=avc1]+bestaudio/' +
        'bestvideo+bestaudio/best';

      // Скачиваем лучшее качество
      let lastProgressBucket = -1;
      filepath = await this.ytdlpService.downloadVideo(
        videoInfo.url,
        iosFormat,
        filepath,
        false,
        async (progress) => {
          const bucket = Math.floor(progress / 15);
          if (bucket === lastProgressBucket) return;
          lastProgressBucket = bucket;

          const bar = createProgressBar(progress);
          await this.bot.api
            .editMessageText(
              chatId,
              progressMsg.message_id,
              `⬇️ Скачивание\n${bar} ${Math.floor(progress)}%`,
            )
            .catch(() => {});
        },
      );

      // 🍏 Гарантируем совместимость с iPhone (перекод в H.264/yuv420p,
      // только если нужно — иначе вернёт тот же файл мгновенно)
      await this.bot.api
        .editMessageText(
          chatId,
          progressMsg.message_id,
          '🔄 Обрабатываю видео...',
        )
        .catch(() => {});
      await this.ytdlpService.ensureIphoneCompatible(filepath);

      await this.bot.api
        .editMessageText(
          chatId,
          progressMsg.message_id,
          '📤 Загрузка в Телеграм...',
        )
        .catch(() => {});

      // Загружаем в канал и кешируем
      let uploadResult: { fileId: string; messageId: number };
      try {
        uploadResult = await this.uploaderService.cacheToChannel(
          filepath,
          videoInfo,
          false,
        );
      } catch (cacheError: any) {
        this.logger.warn(`⚠️ Кеш не удался, отправляю напрямую`);
        await this.bot.api.sendVideo(chatId, new InputFile(filepath), {
          caption: `✅ ${videoInfo.title}\n\n📢 ${this.yourUsername}`,
          supports_streaming: true,
        });
        await fs.unlink(filepath).catch(() => {});
        await this.bot.api
          .deleteMessage(chatId, progressMsg.message_id)
          .catch(() => {});
        return;
      }

      // Отправляем пользователю
      await this.bot.api.sendVideo(chatId, uploadResult.fileId, {
        caption: `✅ ${videoInfo.title}\n\n📢 ${this.yourUsername}`,
        supports_streaming: true,
      });

      // 💾 Сохраняем в кеш БД — повторные запросы этого видео будут мгновенными
      await this.saveToCache(
        filepath,
        videoInfo,
        DownloaderService.DIRECT_FORMAT_ID,
        DownloaderService.DIRECT_RESOLUTION,
        uploadResult,
        userId,
        false,
      );

      // Очистка
      await this.bot.api
        .deleteMessage(chatId, progressMsg.message_id)
        .catch(() => {});
      await fs.unlink(filepath).catch(() => {});

      // Статистика
      await this.userService.incrementDownloads(userId);
      this.advertisementService.incrementUserDownloads(userId);
    } catch (error: any) {
      this.logger.error(`❌ Direct download error: ${error.stack}`);
      if (progressMsg) {
        await this.bot.api
          .editMessageText(
            chatId,
            progressMsg.message_id,
            `❌ Ошибка: ${error.message}`,
          )
          .catch(() => {});
      }
    }
  }
}
