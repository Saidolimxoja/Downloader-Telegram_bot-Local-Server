// src/modules/downloader/download-executor.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs/promises';
import { YtdlpService } from '../ytdlp/ytdlp.service';
import { CacheService } from '../cache/cache.service';
import { UploaderService } from '../uploader/uploader.service';
import { RedisService } from '../../common/redis/redis.service';
import {
  REDIS_KEYS,
  REDIS_TTL,
} from '../../common/constants/redis-keys.constant';
import { MediaDeliveryService } from './media-delivery.service';
import { VideoSessionService } from './video-session/video-session.service';
import { DownloaderService } from './downloader.service';
import { VideoInfoDto } from './dto/video-info.dto';
import { DownloadJobData } from './interfaces/download-job.interface';
import {
  generateCacheKey,
  sanitizeFilename,
} from '../../common/utils/file.utils';
import { createProgressBar } from '../../common/utils/format.utils';

/**
 * 🍏 Селектор форматов для быстрой выдачи коротких видео.
 *
 * Порядок предпочтений: готовый муксированный H.264-файл (мгновенно, без
 * склейки) → H.264 + AAC раздельно → H.264 + любое аудио → что угодно.
 * Гонимся за скоростью, а не за максимальным разрешением: reels и shorts
 * должны приходить за секунды.
 */
const IOS_FRIENDLY_FORMAT =
  'best/' +
  'bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/' +
  'bestvideo[vcodec^=avc1]+bestaudio/' +
  'bestvideo+bestaudio/best';

/** Ошибка, при которой повторять задачу бессмысленно */
class PermanentDownloadError extends Error {}

/**
 * ⬇️ ВЫПОЛНЕНИЕ ЗАГРУЗОК (сторона воркера)
 *
 * Раньше здесь было два метода на 350 строк с почти одинаковым телом:
 * executeDownloadLogic и executeDirectDownloadLogic. Обе скачивали, заливали
 * в архив, кешировали, отправляли и чистили за собой — разными словами.
 * Теперь общий конвейер один, а различия сведены к параметрам.
 */
@Injectable()
export class DownloadExecutorService {
  private readonly logger = new Logger(DownloadExecutorService.name);
  private readonly downloadsDir: string;

  constructor(
    private readonly ytdlpService: YtdlpService,
    private readonly cacheService: CacheService,
    private readonly uploaderService: UploaderService,
    private readonly videoSessionService: VideoSessionService,
    private readonly media: MediaDeliveryService,
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.downloadsDir = config.get<string>('DOWNLOADS_DIR') || './downloads';
  }

  /**
   * Точка входа для задачи из очереди.
   *
   * ⚠️ Ошибки ДО выдачи файла пробрасываются наружу — только так работает
   * механизм повторов BullMQ. Раньше их глушил внутренний catch, из-за чего
   * настройка attempts: 3 не срабатывала ни разу, а очередь всегда выглядела
   * стопроцентно успешной.
   */
  async execute(data: DownloadJobData): Promise<void> {
    const chatId = data.chatId;
    const userId = BigInt(data.userId);

    const info = await this.videoSessionService.get(data.sessionId);

    if (!info) {
      // Данные сессии истекли — повторять нечего, просим прислать ссылку снова
      await this.media.editMessage(
        chatId,
        data.progressMsgId,
        '❌ Данные устарели. Пришли ссылку заново.',
      );
      return;
    }

    try {
      if (data.isDirect) {
        await this.runDirect(data, info, userId);
      } else {
        await this.runWithSelectedQuality(data, info, userId);
      }
    } catch (error: any) {
      const message =
        error instanceof PermanentDownloadError
          ? error.message
          : 'Не удалось скачать видео. Попробуй ещё раз чуть позже.';

      await this.media.editMessage(chatId, data.progressMsgId, `❌ ${message}`);

      // Постоянные ошибки (приватное видео, гео-блокировка) повторять
      // бессмысленно — три попытки просто держали бы слот очереди 15 минут
      if (error instanceof PermanentDownloadError) {
        this.logger.warn(`⛔ Постоянная ошибка: ${error.message}`);
        return;
      }

      throw error;
    }
  }

  // ==================== СЦЕНАРИИ ====================

  /** Загрузка с выбранным пользователем качеством */
  private async runWithSelectedQuality(
    data: DownloadJobData,
    info: VideoInfoDto,
    userId: bigint,
  ): Promise<void> {
    const formatId = data.formatId || 'best';
    const resolution = data.resolution || 'best';
    const isAudio = data.isAudio === true;

    // Готовый селектор ('+' или 'best') используем как есть, иначе достраиваем
    const ytdlpFormat = isAudio
      ? formatId || 'bestaudio/best'
      : /\+|best/.test(formatId)
        ? formatId
        : `${formatId}+bestaudio/best`;

    await this.downloadAndDeliver({
      chatId: data.chatId,
      userId,
      info,
      sourceUrl: info.url,
      ytdlpFormat,
      cacheFormatId: formatId,
      cacheResolution: resolution,
      isAudio,
      progressMsgId: data.progressMsgId,
      // Перекодировку под iPhone делаем только для коротких видео: для
      // полноразмерного YouTube она стоила бы минут CPU на каждый ролик
      ensureIphoneCompatible: false,
      filenameSuffix: formatId,
    });
  }

  /** Прямая загрузка без выбора качества (Reels / Shorts) */
  private async runDirect(
    data: DownloadJobData,
    info: VideoInfoDto,
    userId: bigint,
  ): Promise<void> {
    const chatId = data.chatId;

    // 📦 Карусель — отдельный сценарий: несколько файлов одним альбомом
    if (data.isInstagram && info.entries && info.entries.length > 1) {
      await this.runCarousel(data, info, userId);
      return;
    }

    // ⚡ Instagram отдаёт прямую ссылку на готовый H.264-файл — Telegram
    // скачает её сам, минуя наш сервер и диск
    if (data.isInstagram && info.directUrl) {
      const delivered = await this.tryUrlDirect(chatId, userId, info, data);
      if (delivered) return;
    }

    await this.downloadAndDeliver({
      chatId,
      userId,
      info,
      sourceUrl: info.url,
      ytdlpFormat: IOS_FRIENDLY_FORMAT,
      cacheFormatId: DownloaderService.DIRECT_FORMAT_ID,
      cacheResolution: DownloaderService.DIRECT_RESOLUTION,
      isAudio: false,
      progressMsgId: data.progressMsgId,
      ensureIphoneCompatible: true,
      filenameSuffix: data.isInstagram ? 'ig' : 'short',
    });
  }

  // ==================== ОБЩИЙ КОНВЕЙЕР ====================

  private async downloadAndDeliver(params: {
    chatId: number;
    userId: bigint;
    info: VideoInfoDto;
    sourceUrl: string;
    ytdlpFormat: string;
    cacheFormatId: string;
    cacheResolution: string;
    isAudio: boolean;
    progressMsgId?: number;
    ensureIphoneCompatible: boolean;
    filenameSuffix: string;
  }): Promise<void> {
    const {
      chatId,
      userId,
      info,
      cacheFormatId,
      cacheResolution,
      isAudio,
      progressMsgId,
    } = params;

    // 1️⃣ Пока задача ждала в очереди, видео мог скачать кто-то другой
    const cached = await this.cacheService.get(
      info.id,
      cacheFormatId,
      cacheResolution,
    );

    if (cached) {
      const delivered = await this.media.deliverFromCache(
        chatId,
        userId,
        cached,
        info,
        { isAudio, resolution: cacheResolution },
      );

      if (delivered) {
        await this.media.deleteMessage(chatId, progressMsgId);
        return;
      }
    }

    // 2️⃣ Дедупликация: если это же видео в этом же качестве уже качается,
    // ждём чужой результат вместо запуска второго yt-dlp на тот же файл
    const cacheKey = generateCacheKey(info.id, cacheFormatId, cacheResolution);
    const lockKey = REDIS_KEYS.downloadLock(cacheKey);
    const gotLock = await this.redis.acquireLock(
      lockKey,
      REDIS_TTL.downloadLock,
    );

    if (!gotLock) {
      await this.media.editMessage(
        chatId,
        progressMsgId,
        '⏳ Это видео уже качается, сейчас пришлю...',
      );

      const shared = await this.waitForCache(
        info.id,
        cacheFormatId,
        cacheResolution,
      );

      if (shared) {
        const delivered = await this.media.deliverFromCache(
          chatId,
          userId,
          shared,
          info,
          { isAudio, resolution: cacheResolution },
        );

        if (delivered) {
          await this.media.deleteMessage(chatId, progressMsgId);
          return;
        }
      }
      // Не дождались — качаем сами. Имя файла уникально, помешать друг другу
      // процессы не смогут.
    }

    let filepath = '';

    try {
      await this.media.editMessage(
        chatId,
        progressMsgId,
        '⬇️ Начинаю загрузку...',
      );

      // 3️⃣ Скачивание
      filepath = await this.downloadFile(params);

      // 4️⃣ Совместимость с iPhone — только для коротких видео
      if (params.ensureIphoneCompatible) {
        await this.media.editMessage(
          chatId,
          progressMsgId,
          '🔄 Обрабатываю видео...',
        );
        await this.ytdlpService.ensureIphoneCompatible(filepath);
      }

      // 5️⃣ Заливка в архивный канал и кеш
      await this.media.editMessage(
        chatId,
        progressMsgId,
        '📤 Загрузка в Телеграм...',
      );

      const uploadResult = await this.media.uploadAndCache(filepath, info, {
        formatId: cacheFormatId,
        resolution: cacheResolution,
        userId,
        isAudio,
      });

      // 6️⃣ Выдача пользователю.
      // После этой строки ошибки наружу не пробрасываются: файл человек уже
      // получил, повтор задачи прислал бы ему дубль.
      if (uploadResult) {
        await this.media.sendByFileId(chatId, uploadResult.fileId, {
          isAudio,
          caption: this.media.buildCaption(info.title, cacheResolution),
          title: info.title,
          performer: info.uploader,
        });
      } else {
        // Архивный канал недоступен — отдаём файл напрямую с диска
        await this.media.sendFromDisk(
          chatId,
          filepath,
          info,
          isAudio,
          cacheResolution,
        );
      }
    } finally {
      // Временные файлы удаляем при любом исходе — раньше при ошибке они
      // оставались на диске навсегда
      await this.media.cleanupFiles(filepath);
      if (gotLock) await this.redis.releaseLock(lockKey);
    }

    await this.media.deleteMessage(chatId, progressMsgId);
    await this.media.registerDownload(chatId, userId);
  }

  /**
   * Скачивание файла с показом прогресса.
   *
   * Имя файла содержит случайный суффикс. Раньше оно строилось только из
   * названия и формата — два человека, запросившие одно видео одновременно,
   * писали в ОДИН файл и получали битый результат.
   */
  private async downloadFile(params: {
    chatId: number;
    info: VideoInfoDto;
    sourceUrl: string;
    ytdlpFormat: string;
    isAudio: boolean;
    progressMsgId?: number;
    filenameSuffix: string;
  }): Promise<string> {
    const unique = crypto.randomBytes(4).toString('hex');
    const title = sanitizeFilename(params.info.title).slice(0, 80);
    const ext = params.isAudio ? 'm4a' : 'mp4';
    const filename = `${title}_${params.filenameSuffix}_${unique}.${ext}`;

    let lastBucket = -1;

    try {
      return await this.ytdlpService.downloadVideo(
        params.sourceUrl,
        params.ytdlpFormat,
        path.resolve(this.downloadsDir, filename),
        params.isAudio,
        (progress) => {
          // Обновляем сообщение раз в 15% — иначе Telegram отдаёт флуд-лимит
          const bucket = Math.floor(progress / 15);
          if (bucket === lastBucket) return;
          lastBucket = bucket;

          // Намеренно не ждём ответа Telegram: обновление прогресса не должно
          // тормозить чтение вывода yt-dlp. Ошибки editMessage глушит сам.
          void this.media.editMessage(
            params.chatId,
            params.progressMsgId,
            `⬇️ Скачивание\n${createProgressBar(progress)} ${Math.floor(progress)}%`,
          );
        },
      );
    } catch (error: any) {
      throw this.classifyError(error);
    }
  }

  /**
   * ⚡ Отдать Telegram прямую ссылку — он скачает файл сам.
   * Возвращает false, если не получилось: тогда качаем обычным способом.
   */
  private async tryUrlDirect(
    chatId: number,
    userId: bigint,
    info: VideoInfoDto,
    data: DownloadJobData,
  ): Promise<boolean> {
    if (!info.directUrl) return false;

    try {
      await this.media.editMessage(
        chatId,
        data.progressMsgId,
        '⚡ Готовлю видео...',
      );

      const uploadResult = await this.uploaderService.cacheUrlToChannel(
        info.directUrl,
        info,
      );

      await this.media.sendByFileId(chatId, uploadResult.fileId, {
        caption: this.media.buildCaption(info.title),
      });

      // Файла на диске нет, поэтому размер записываем нулевым
      await this.media.saveToCache('', info, uploadResult, {
        formatId: DownloaderService.DIRECT_FORMAT_ID,
        resolution: DownloaderService.DIRECT_RESOLUTION,
        userId,
        isAudio: false,
        fileSize: 0n,
      });

      await this.media.deleteMessage(chatId, data.progressMsgId);
      await this.media.registerDownload(chatId, userId);

      this.logger.log(`⚡ URL-direct успех: ${info.id}`);
      return true;
    } catch (error: any) {
      this.logger.warn(`⚠️ URL-direct не удался: ${error.message}`);
      return false;
    }
  }

  /** 📦 Карусель Instagram: несколько роликов одним альбомом */
  private async runCarousel(
    data: DownloadJobData,
    info: VideoInfoDto,
    userId: bigint,
  ): Promise<void> {
    const chatId = data.chatId;
    const entries = info.entries || [];
    const fileIds: string[] = [];
    let totalSize = 0n;

    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];

      await this.media.editMessage(
        chatId,
        data.progressMsgId,
        `⬇️ Загружаю видео ${index + 1} из ${entries.length}...`,
      );

      const entryCached = await this.cacheService.get(
        entry.id,
        DownloaderService.DIRECT_FORMAT_ID,
        DownloaderService.DIRECT_RESOLUTION,
      );

      if (entryCached) {
        fileIds.push(entryCached.fileId);
        totalSize += entryCached.fileSize || 0n;
        continue;
      }

      const unique = crypto.randomBytes(4).toString('hex');
      const filename = `${sanitizeFilename(entry.title).slice(0, 60)}_ig_${entry.id}_${unique}.mp4`;
      let filepath = '';

      try {
        filepath = await this.ytdlpService.downloadVideo(
          entry.url,
          IOS_FRIENDLY_FORMAT,
          path.resolve(this.downloadsDir, filename),
          false,
          () => {}, // прогресс по каждому ролику — это флуд в чат
        );

        await this.ytdlpService.ensureIphoneCompatible(filepath);

        const uploadResult = await this.media.uploadAndCache(filepath, entry, {
          formatId: DownloaderService.DIRECT_FORMAT_ID,
          resolution: DownloaderService.DIRECT_RESOLUTION,
          userId,
          isAudio: false,
        });

        if (!uploadResult) {
          throw new Error('Не удалось залить элемент карусели в архив');
        }

        totalSize += await this.fileSize(filepath);
        fileIds.push(uploadResult.fileId);
      } finally {
        await this.media.cleanupFiles(filepath);
      }
    }

    if (fileIds.length === 0) {
      throw new PermanentDownloadError(
        'В этом посте нет видео для скачивания.',
      );
    }

    await this.media.sendAlbum(
      chatId,
      fileIds,
      this.media.buildCaption(info.title),
    );

    // Кешируем альбом целиком: повторный запрос отдастся одним махом
    await this.media.saveToCache(
      '',
      info,
      { fileId: fileIds.join(','), messageId: 0 },
      {
        formatId: DownloaderService.DIRECT_FORMAT_ID,
        resolution: DownloaderService.DIRECT_RESOLUTION,
        userId,
        isAudio: false,
        fileType: 'album',
        fileSize: totalSize,
      },
    );

    await this.media.deleteMessage(chatId, data.progressMsgId);
    await this.media.registerDownload(chatId, userId);
  }

  // ==================== СЛУЖЕБНОЕ ====================

  /**
   * Ждём, пока чужая загрузка того же видео попадёт в кеш.
   * Опрашиваем нечасто: секунда ожидания дешевле лишнего запроса к БД.
   */
  private async waitForCache(
    videoId: string,
    formatId: string,
    resolution: string,
    timeoutMs = 120_000,
  ) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 3000));

      const cached = await this.cacheService.get(videoId, formatId, resolution);
      if (cached) return cached;

      // Держатель блокировки отвалился — берём работу на себя
      const stillLocked = await this.redis.get(
        REDIS_KEYS.downloadLock(
          generateCacheKey(videoId, formatId, resolution),
        ),
      );
      if (!stillLocked) return null;
    }

    return null;
  }

  /**
   * Отличаем «видео недоступно навсегда» от «сеть моргнула».
   * Первое повторять бессмысленно, второе — обязательно нужно.
   */
  private classifyError(error: Error): Error {
    const text = (error.message || '').toLowerCase();

    const permanent = [
      'private video',
      'video unavailable',
      'you need to log in',
      'removed by the uploader',
      'account has been terminated',
      'age',
      'copyright',
      'not available in your country',
    ];

    if (permanent.some((marker) => text.includes(marker))) {
      return new PermanentDownloadError(
        'Это видео недоступно: оно приватное, удалено или ограничено.',
      );
    }

    return error;
  }

  private async fileSize(filepath: string): Promise<bigint> {
    try {
      const stats = await fs.stat(filepath);
      return BigInt(stats.size);
    } catch {
      return 0n;
    }
  }
}
