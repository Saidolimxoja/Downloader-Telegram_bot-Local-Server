// src/modules/downloader/media-delivery.service.ts

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, Context, InputFile } from 'grammy';
import { CachedFile } from '@prisma/client';
import * as fs from 'fs/promises';
import { TELEGRAM_BOT } from '../telegram/telegram.module';
import { CacheService } from '../cache/cache.service';
import { UserService } from '../user/user.service';
import { AdvertisementService } from '../advertisement/advertisement.service';
import { UploaderService } from '../uploader/uploader.service';
import { YtdlpService } from '../ytdlp/ytdlp.service';
import { VideoInfoDto } from './dto/video-info.dto';

/**
 * 📦 ОБЩИЙ СЛОЙ ВЫДАЧИ ФАЙЛОВ
 *
 * Три сценария загрузки (выбор качества, прямая загрузка, карусель) делали
 * одно и то же: залить в архивный канал → сохранить в кеш → отправить
 * пользователю → удалить временные файлы → обновить статистику. Код был
 * скопирован трижды, и правка в одном месте молча расходилась с остальными.
 *
 * Здесь эта последовательность живёт в одном экземпляре.
 */
@Injectable()
export class MediaDeliveryService {
  private readonly logger = new Logger(MediaDeliveryService.name);
  private readonly botUsername: string;

  constructor(
    @Inject(TELEGRAM_BOT) private readonly bot: Bot<Context>,
    private readonly cacheService: CacheService,
    private readonly userService: UserService,
    private readonly advertisementService: AdvertisementService,
    private readonly uploaderService: UploaderService,
    private readonly ytdlpService: YtdlpService,
    config: ConfigService,
  ) {
    this.botUsername = config.get<string>('YOUR_USERNAME') || '@your_bot';
  }

  // ==================== ТЕКСТЫ ====================

  /** Подпись под готовым файлом */
  buildCaption(title: string, resolution?: string): string {
    const quality =
      resolution && resolution !== 'best' ? `\n\n📥 ${resolution}` : '';
    return `✅ ${title}${quality}\n\n📢 ${this.botUsername}`;
  }

  // ==================== ОТПРАВКА ====================

  /**
   * Отправить готовый файл пользователю по file_id.
   *
   * Разветвление «аудио или видео» повторялось в коде шесть раз — теперь оно
   * тут одно.
   */
  async sendByFileId(
    chatId: number,
    fileId: string,
    options: {
      isAudio?: boolean;
      caption: string;
      title?: string;
      performer?: string;
    },
  ): Promise<void> {
    if (options.isAudio) {
      await this.bot.api.sendAudio(chatId, fileId, {
        caption: options.caption,
        title: options.title,
        performer: options.performer || undefined,
      });
      return;
    }

    await this.bot.api.sendVideo(chatId, fileId, {
      caption: options.caption,
      supports_streaming: true,
    });
  }

  /** Отправить альбом (карусель Instagram) одним сообщением */
  async sendAlbum(
    chatId: number,
    fileIds: string[],
    caption: string,
  ): Promise<void> {
    const mediaGroup = fileIds.map((media, index) => ({
      type: 'video' as const,
      media,
      caption: index === 0 ? caption : undefined,
    }));

    await this.bot.api.sendMediaGroup(chatId, mediaGroup);
  }

  /**
   * Аварийная отправка файла с диска — когда архивный канал недоступен.
   * Идёт через локальный Bot API, поэтому ограничения в 50 МБ здесь нет.
   */
  async sendFromDisk(
    chatId: number,
    filepath: string,
    info: VideoInfoDto,
    isAudio: boolean,
    resolution?: string,
  ): Promise<void> {
    const caption = this.buildCaption(info.title, resolution);

    if (isAudio) {
      await this.bot.api.sendAudio(chatId, new InputFile(filepath), {
        caption,
        title: info.title,
        performer: info.uploader || undefined,
      });
      return;
    }

    await this.bot.api.sendVideo(chatId, new InputFile(filepath), {
      caption,
      supports_streaming: true,
    });
  }

  // ==================== ВЫДАЧА ИЗ КЕША ====================

  /**
   * Попытаться отдать файл из кеша.
   *
   * Возвращает false, если file_id протух — вызывающий код тогда качает
   * заново. Telegram изредка инвалидирует идентификаторы, и раньше это
   * обрабатывалось тремя почти одинаковыми блоками try/catch.
   */
  async deliverFromCache(
    chatId: number,
    userId: bigint,
    cached: CachedFile,
    info: VideoInfoDto,
    options: { isAudio?: boolean; resolution?: string } = {},
  ): Promise<boolean> {
    const caption = this.buildCaption(info.title, options.resolution);

    try {
      // Карусель хранится как несколько file_id через запятую
      if (cached.fileId.includes(',')) {
        await this.sendAlbum(chatId, cached.fileId.split(','), caption);
      } else {
        await this.sendByFileId(chatId, cached.fileId, {
          isAudio: options.isAudio,
          caption,
          title: info.title,
          performer: info.uploader,
        });
      }
    } catch (error: any) {
      this.logger.warn(`⚠️ file_id из кеша не сработал: ${error.message}`);
      return false;
    }

    await this.cacheService.recordCacheHit(cached.id, userId).catch(() => {});
    await this.registerDownload(chatId, userId);
    return true;
  }

  // ==================== ЗАЛИВКА И КЕШИРОВАНИЕ ====================

  /**
   * Залить файл в архивный канал и записать в кеш.
   *
   * Ошибка заливки — не фатальна: возвращаем null, и вызывающий код отдаёт
   * файл пользователю напрямую с диска.
   */
  async uploadAndCache(
    filepath: string,
    info: VideoInfoDto,
    params: {
      formatId: string;
      resolution: string;
      userId: bigint;
      isAudio: boolean;
    },
  ): Promise<{ fileId: string; messageId: number } | null> {
    let uploadResult: { fileId: string; messageId: number };

    try {
      uploadResult = await this.uploaderService.cacheToChannel(
        filepath,
        info,
        params.isAudio,
      );
    } catch (error: any) {
      this.logger.warn(`⚠️ Заливка в архив не удалась: ${error.message}`);
      return null;
    }

    await this.saveToCache(filepath, info, uploadResult, params);
    return uploadResult;
  }

  /**
   * Записать результат в кеш БД. Никогда не бросает: файл уже готов,
   * ронять выдачу из-за проблемы со статистикой нельзя.
   */
  async saveToCache(
    filepath: string,
    info: VideoInfoDto,
    uploadResult: { fileId: string; messageId: number },
    params: {
      formatId: string;
      resolution: string;
      userId: bigint;
      isAudio: boolean;
      fileType?: 'video' | 'audio' | 'album';
      fileSize?: bigint;
    },
  ): Promise<void> {
    try {
      const size =
        params.fileSize ?? (filepath ? await this.fileSize(filepath) : 0n);

      await this.cacheService.set({
        url: info.id,
        formatId: params.formatId,
        resolution: params.resolution,
        fileId: uploadResult.fileId,
        archiveMessageId: uploadResult.messageId,
        fileSize: size,
        fileType: params.fileType ?? (params.isAudio ? 'audio' : 'video'),
        userId: params.userId,
        title: info.title,
        uploader: info.uploader || undefined,
        duration: info.duration || undefined,
      });
    } catch (error: any) {
      this.logger.error(`❌ Сохранение в кеш: ${error.message}`);
    }
  }

  // ==================== СТАТИСТИКА ====================

  /**
   * Отметить выданную загрузку и, если пора, показать рекламу.
   *
   * Раньше реклама показывалась только при попадании в кеш — в обработчике
   * сообщения, где был ctx. После реальной загрузки её не видел никто.
   */
  async registerDownload(chatId: number, userId: bigint): Promise<void> {
    await this.userService.incrementDownloads(userId).catch(() => {});
    await this.advertisementService
      .incrementUserDownloads(userId)
      .catch(() => {});

    // В группах реклама не показывается: там бот — гость, и объявление
    // увидят люди, которые ничего не запрашивали. У групповых чатов
    // идентификатор отрицательный, этого признака достаточно.
    if (chatId < 0) return;

    try {
      if (await this.advertisementService.shouldShowAd(userId)) {
        await this.advertisementService.showAdToChat(chatId, userId);
      }
    } catch (error: any) {
      this.logger.warn(`⚠️ Показ рекламы: ${error.message}`);
    }
  }

  // ==================== СЛУЖЕБНОЕ ====================

  /** Удалить видеофайл и сгенерированное к нему превью */
  async cleanupFiles(filepath: string): Promise<void> {
    if (!filepath) return;

    await fs.unlink(filepath).catch(() => {});

    const thumb = this.ytdlpService.getThumbnailPath(filepath);
    if (thumb) await fs.unlink(thumb).catch(() => {});
  }

  /** Безопасно отредактировать сообщение — оно могло быть удалено пользователем */
  async editMessage(
    chatId: number,
    messageId: number | undefined,
    text: string,
  ): Promise<void> {
    if (!messageId) return;

    await this.bot.api.editMessageText(chatId, messageId, text).catch(() => {});
  }

  /** Безопасно удалить сообщение */
  async deleteMessage(
    chatId: number,
    messageId: number | undefined,
  ): Promise<void> {
    if (!messageId) return;

    await this.bot.api.deleteMessage(chatId, messageId).catch(() => {});
  }

  async sendMessage(chatId: number, text: string): Promise<number | undefined> {
    try {
      const message = await this.bot.api.sendMessage(chatId, text);
      return message.message_id;
    } catch (error: any) {
      this.logger.warn(`⚠️ Не удалось отправить сообщение: ${error.message}`);
      return undefined;
    }
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
