// src/modules/downloader/downloader.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Context, InlineKeyboard, Bot } from 'grammy';
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
import { VideoSessionService } from './video-session.service';
import { MESSAGES } from 'src/common/constants/messages.constant';

@Injectable()
export class DownloaderService {
  private readonly logger = new Logger(DownloaderService.name);
  private videoDataCache = new Map<string, VideoInfoDto>();
  private activeDownloads = new Map<string, Promise<void>>();
  private readonly downloadsDir: string;
  private readonly yourUsername: string;

  constructor(
    private ytdlpService: YtdlpService,
    private queueService: QueueService,
    private cacheService: CacheService,
    private uploaderService: UploaderService,
    private userService: UserService,
    private config: ConfigService,
    private advertisementService: AdvertisementService,
    private videoSessionService: VideoSessionService,
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

    try {
      progressMsg = await ctx.reply('🔍 Анализирую ссылку...');

      const videoInfo = await this.ytdlpService.getVideoInfo(url);

      const sessionId = crypto.randomBytes(8).toString('hex');

      this.videoDataCache.set(sessionId, videoInfo);
      await this.videoSessionService.save(sessionId, videoInfo);

      const MIN_RESOLUTION = 360;
      const MAX_RESOLUTION = 1080;
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
          // Сортировка по убыванию качества (лучшее → худшее)
          const hA = parseInt(a.resolution, 10) || 0;
          const hB = parseInt(b.resolution, 10) || 0;
          return hB - hA; // ← вот ключевой момент: hB - hA
        });

      // 2. Собираем финальный порядок: лучшие видео → ... → аудио (если есть)
      const visibleFormats = [...videoFormats];
      if (audioFormat) {
        visibleFormats.push(audioFormat);
      }

      // 3. Если ничего не осталось — можно добавить обработку
      if (visibleFormats.length === 0) {
        // например, показать сообщение или fallback
        await ctx.reply('Доступные качества слишком низкие или отсутствуют.');
        return;
      }

      // 4. Создаём клавиатуру
      const keyboard = new InlineKeyboard();

      visibleFormats.forEach((format, idx) => {
        const key = `${sessionId}|${format.formatId}|${format.resolution}`;
        const sizeText = format.filesize
          ? formatFileSize(format.filesize)
          : '~ MB';

        const label =
          format.resolution === 'audio'
            ? `🎵 Аудио • ${sizeText}`
            : `🎥 ${format.resolution} • ${sizeText}`;

        // ⭐ только на самой первой кнопке (лучшее видео)
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
    } catch (error) {
      this.logger.error('Ошибка анализа видео', error);
      const errorMsg =
        '❌ Не удалось проанализировать ссылку.\nВозможно, видео недоступно или слишком длинное.';
      if (progressMsg) {
        await ctx.api
          .editMessageText(chatId, progressMsg.message_id, errorMsg)
          .catch(() => {});
      } else {
        await ctx.reply(errorMsg);
      }
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
    let videoData = this.videoDataCache.get(videoId);
    if (!videoData) {
      const dbData = await this.videoSessionService.get(videoId);
      if (!dbData) {
        await ctx.answerCallbackQuery({
          text: '❌ Ссылка устарела. Отправьте видео заново.',
        });
        return;
      }
      videoData = dbData;
      this.videoDataCache.set(videoId, videoData);
    }

    // Проверяем кеш
    const cached = await this.cacheService.get(
      videoData.id,
      formatId,
      resolution,
    );

    if (cached) {
      this.logger.log(`🎯 Cache HIT: ${resolution}`);
      await ctx.answerCallbackQuery({
        text: MESSAGES.FROM_CACHE || '✅ Из кеша',
      });

      const isAudio = resolution === 'audio';
      const caption = `✅ ${videoData.title}\n\n📥 ${resolution}\n\n📢 ${this.yourUsername}`;

      try {
        if (isAudio) {
          await ctx.replyWithAudio(cached.fileId, {
            caption,
            title: videoData.title,
            performer: videoData.uploader || undefined,
          });
        } else {
          await ctx.replyWithVideo(cached.fileId, {
            caption,
            supports_streaming: true,
          });
        }

        await this.cacheService.recordCacheHit(cached.id, userId);
        await this.userService.incrementDownloads(userId);
        this.advertisementService.incrementUserDownloads(userId);

        if (await this.advertisementService.shouldShowAd(userId)) {
          await this.advertisementService.showAd(ctx);
        }
        return;
      } catch (e) {
        this.logger.warn(`FileID протух, качаем заново...`);
      }
    }

    // Проверка дубликатов загрузок
    const downloadKey = `${videoData.id}|${formatId}`;
    if (this.activeDownloads.has(downloadKey)) {
      await ctx.answerCallbackQuery({ text: '⏳ Уже скачивается, ждите...' });
      return;
    }

    await ctx.answerCallbackQuery({ text: '⬇️ Добавлено в очередь...' });

    // Добавляем в очередь
    const downloadPromise = this.queueService.add(() =>
      this.processDownload(ctx, bot, videoData!, formatId, resolution, userId),
    );

    this.activeDownloads.set(downloadKey, downloadPromise);
    downloadPromise.finally(() => this.activeDownloads.delete(downloadKey));
  }

  /**
   * 📥 ПРОЦЕСС СКАЧИВАНИЯ И ЗАГРУЗКИ
   */
  private async processDownload(
    ctx: Context,
    bot: Bot<Context>,
    videoData: VideoInfoDto,
    formatId: string,
    resolution: string,
    userId: bigint,
  ): Promise<void> {
    if (!ctx.chat) return;
    const chatId = ctx.chat.id;
    let progressMsg;

    try {
      progressMsg = await ctx.reply('⬇️ Начинаю загрузку...');

      const sanitizedTitle = sanitizeFilename(videoData.title);
      const isAudio = resolution === 'audio';
      const fileExt = isAudio ? 'm4a' : 'mp4';

      const filename = `${sanitizedTitle}_${formatId}.${fileExt}`;
      const filepath = path.resolve(this.downloadsDir, filename);

      const sourceUrl =
        videoData.url || `https://www.youtube.com/watch?v=${videoData.id}`;

      // 1️⃣ СКАЧИВАНИЕ (yt-dlp с оптимизацией для стриминга)
      await this.ytdlpService.downloadVideo(
        sourceUrl,
        formatId,
        filepath,
        isAudio,
        async (progress) => {
          if (Math.floor(progress) % 15 === 0) {
            const bar = createProgressBar(progress);
            await ctx.api
              .editMessageText(
                chatId,
                progressMsg.message_id,
                `⬇️ Скачивание\n${bar} ${Math.floor(progress)}%`,
              )
              .catch(() => {});
          }
        },
      );

      await ctx.api.editMessageText(
        chatId,
        progressMsg.message_id,
        '📤 Загрузка в Телеграм...',
      );

      // 2️⃣ ЗАГРУЗКА В АРХИВНЫЙ КАНАЛ (через Local API для больших файлов)
      // 🔥 ИСПРАВЛЕНО: Правильная сигнатура метода
      const uploadResult = await this.uploaderService.cacheToChannel(
        filepath,
        videoData,
        isAudio,
      );

      this.logger.log(`📥 Попытка записи в БД кеш для: ${videoData.id}`);

      // 3️⃣ СОХРАНЕНИЕ В КЕШ БД
      try {
        const fileStats = await fs.stat(filepath);

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

        this.logger.log(`✅ Успешно сохранено в БД`);
      } catch (dbError: any) {
        this.logger.error(`❌ Ошибка сохранения в БД: ${dbError.message}`);
      }

      // 4️⃣ ОТПРАВКА ПОЛЬЗОВАТЕЛЮ (по file_id из архива)
      const userCaption = `✅ ${videoData.title}\n\n📥 ${resolution}\n\n📢 ${this.yourUsername}`;

      if (isAudio) {
        await ctx.replyWithAudio(uploadResult.fileId, {
          caption: userCaption,
          title: videoData.title,
          performer: videoData.uploader || undefined,
        });
      } else {
        await ctx.replyWithVideo(uploadResult.fileId, {
          caption: userCaption,
          supports_streaming: true,
        });
      }

      // 5️⃣ ОЧИСТКА
      await ctx.api
        .deleteMessage(chatId, progressMsg.message_id)
        .catch(() => {});

      await fs.unlink(filepath).catch(() => {});

      // 6️⃣ СТАТИСТИКА
      await this.userService.incrementDownloads(userId);
      this.advertisementService.incrementUserDownloads(userId);
    } catch (error: any) {
      this.logger.error(`Ошибка процесса скачивания: ${error.stack}`);
      if (progressMsg) {
        await ctx.api
          .editMessageText(
            chatId,
            progressMsg.message_id,
            `❌ Ошибка: ${error.message}`,
          )
          .catch(() => {});
      }
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
}
