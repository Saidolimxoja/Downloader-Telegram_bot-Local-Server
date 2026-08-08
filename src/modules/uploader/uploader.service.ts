// src/modules/uploader/uploader.service.ts

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Bot, Context, InputFile } from 'grammy';
import { ConfigService } from '@nestjs/config';
import * as path from 'path';
import { YtdlpService } from '../ytdlp/ytdlp.service';
import { VideoInfoDto } from '../downloader/dto/video-info.dto';
import { TELEGRAM_BOT } from '../telegram/telegram.module';
import {
  cleanTitle,
  escapeHtml,
  formatDuration,
  formatNumber,
  formatUploadDate,
} from '../../common/utils/format.utils';

@Injectable()
export class UploaderService {
  private readonly logger = new Logger(UploaderService.name);
  private readonly archiveChannelId: string;

  constructor(
    private ytdlpService: YtdlpService,
    private config: ConfigService,
    // Бот приходит через DI одним экземпляром на процесс — раньше его
    // прокидывали вручную через setBot() уже после старта модуля, и любой
    // вызов до этого момента падал с «Bot instance не установлен»
    @Inject(TELEGRAM_BOT) private readonly bot: Bot<Context>,
  ) {
    this.archiveChannelId = this.config.get<string>('CHANNEL_ID') || '';
  }

  /**
   * 📤 КЕШИРОВАНИЕ В АРХИВНЫЙ КАНАЛ (через локальный Bot API)
   */
  async cacheToChannel(
    videoPath: string,
    info: VideoInfoDto,
    isAudio: boolean = false,
  ): Promise<{ fileId: string; messageId: number }> {
    const absolutePath = path.resolve(videoPath);
    this.logger.log(`🚀 Отправка через Local API: ${absolutePath}`);

    let message: any;
    let thumbnailPath: string | null | undefined;

    const captionText = this.formatCaption(info);

    try {
      if (isAudio) {
        thumbnailPath = this.ytdlpService.getThumbnailPath(videoPath);
        message = await this.bot.api.sendAudio(
          this.archiveChannelId,
          new InputFile(absolutePath),
          {
            title: info.title,
            performer: info.uploader,
            duration: info.duration,
            caption: captionText,
            parse_mode: 'HTML',
            thumbnail: thumbnailPath
              ? new InputFile(path.resolve(thumbnailPath))
              : undefined,
          },
        );
      } else {
        thumbnailPath = await this.ytdlpService.generateThumbnail(videoPath);
        message = await this.bot.api.sendVideo(
          this.archiveChannelId,
          new InputFile(absolutePath),
          {
            supports_streaming: true,
            duration: info.duration,
            width: info.width,
            height: info.height,
            caption: captionText,
            thumbnail: thumbnailPath
              ? new InputFile(path.resolve(thumbnailPath))
              : undefined,
            parse_mode: 'HTML',
          },
        );
      }

      const fileId: string | undefined = isAudio
        ? message.audio?.file_id
        : message.video?.file_id;

      if (!fileId) {
        this.logger.error(
          `❌ Не удалось получить file_id. Ответ: ${JSON.stringify(message)}`,
        );
        throw new Error('Не удалось получить file_id из ответа Telegram API');
      }

      this.logger.log(
        `✅ Закешировано успешно. MessageID: ${message.message_id}`,
      );
      return { fileId, messageId: message.message_id };
    } catch (error: any) {
      this.logger.error(`❌ Ошибка кеширования: ${error.message}`);
      throw error;
    } finally {
      // Превью удаляем в любом случае: раньше при ошибке отправки .jpg
      // оставался на диске навсегда
      if (thumbnailPath) {
        await this.ytdlpService.safeDelete(thumbnailPath).catch(() => {});
      }
    }
  }

  /**
   * ⚡ URL-DIRECT: отдаём Telegram прямую ссылку, он качает файл сам
   */
  async cacheUrlToChannel(
    fileUrl: string,
    info: VideoInfoDto,
  ): Promise<{ fileId: string; messageId: number }> {
    this.logger.log('⚡ URL-direct: отдаю ссылку Telegram на скачивание');

    const message: any = await this.bot.api.sendVideo(
      this.archiveChannelId,
      fileUrl,
      {
        supports_streaming: true,
        duration: info.duration,
        width: info.width,
        height: info.height,
        caption: this.formatCaption(info),
        parse_mode: 'HTML',
      },
    );

    const fileId: string | undefined = message.video?.file_id;
    if (!fileId) {
      throw new Error('URL-direct: не удалось получить file_id из ответа');
    }

    this.logger.log(
      `✅ URL-direct закеширован. MessageID: ${message.message_id}`,
    );
    return { fileId, messageId: message.message_id };
  }

  /**
   * 📝 Карточка видео для архивного канала.
   * Форматтеры берём из common/utils — раньше formatNumber/formatDate/
   * formatDuration были переписаны здесь заново, третьей копией в проекте.
   */
  public formatCaption(info: VideoInfoDto): string {
    return [
      `🎬 <b>${cleanTitle(info.title || 'Без названия')}</b>`,
      '',
      `👁 ${formatNumber(info.viewCount)} • 👍 ${formatNumber(info.likeCount)}`,
      `📥 ${formatUploadDate(info.uploadDate)} • 🕒 ${formatDuration(info.duration)}`,
      `👤 ${escapeHtml(info.uploader || 'Неизвестно')}`,
    ]
      .join('\n')
      .trim();
  }
}
