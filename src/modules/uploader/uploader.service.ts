import { Injectable, Logger } from '@nestjs/common';
import { InputFile, Bot } from 'grammy';
import { YtdlpService } from '../ytdlp/ytdlp.service';
import { VideoInfoDto } from '../downloader/dto/video-info.dto';
import { ConfigService } from '@nestjs/config';
import * as path from 'path';

@Injectable()
export class UploaderService {
  private readonly logger = new Logger(UploaderService.name);
  private readonly archiveChannelId: string;
  private bot: Bot | null = null;

  constructor(
    private ytdlpService: YtdlpService,
    private config: ConfigService,
  ) {
    this.archiveChannelId = this.config.get<string>('CHANNEL_ID') || '';
  }

  setBot(bot: Bot) {
    this.bot = bot;
    this.logger.log(`🔧 setBot вызван. Bot defined: ${!!bot}`);
  }

  /**
   * 📤 КЕШИРОВАНИЕ В КАНАЛ (для Local API)
   */
  async cacheToChannel(
    videoPath: string,
    info: VideoInfoDto,
    isAudio: boolean = false,
  ): Promise<{ fileId: string; messageId: number }> {
    try {
      if (!this.bot) {
        throw new Error(
          'Bot instance не установлен. Вызовите setBot() сначала.',
        );
      }

      const absolutePath = path.resolve(videoPath);
      this.logger.log(`🚀 Отправка через Local API: ${absolutePath}`);

      let message: any;
      let thumbnailPath: string | null | undefined;

      // Генерируем красивый и БЕЗОПАСНЫЙ caption
      const captionText = this.formatCaption(info);

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
            parse_mode: 'HTML', // Добавлено, чтобы работал formatCaption
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
            caption: captionText, // Используем полную карточку
            thumbnail: thumbnailPath
              ? new InputFile(path.resolve(thumbnailPath))
              : undefined,
            parse_mode: 'HTML',
          },
        );
      }

      let fileId: string | undefined = isAudio
        ? message.audio?.file_id
        : message.video?.file_id;

      if (!fileId) {
        this.logger.error(
          `❌ Не удалось получить file_id. Ответ: ${JSON.stringify(message)}`,
        );
        throw new Error('Не удалось получить file_id из ответа Telegram API');
      }

      if (thumbnailPath) {
        await this.ytdlpService.safeDelete(thumbnailPath).catch(() => {});
      }

      this.logger.log(
        `✅ Закешировано успешно. MessageID: ${message.message_id}`,
      );
      return { fileId, messageId: message.message_id };
    } catch (error: any) {
      this.logger.error(`❌ Ошибка кеширования: ${error.message}`);
      throw error;
    }
  }

  /**
   * ⚡ URL-DIRECT: КЕШИРОВАНИЕ ПО ССЫЛКЕ
   */
  async cacheUrlToChannel(
    fileUrl: string,
    info: VideoInfoDto,
  ): Promise<{ fileId: string; messageId: number }> {
    if (!this.bot) {
      throw new Error('Bot instance не установлен. Вызовите setBot() сначала.');
    }

    this.logger.log(`⚡ URL-direct: отдаю ссылку Telegram на скачивание`);

    const captionText = this.formatCaption(info);

    const message: any = await this.bot.api.sendVideo(
      this.archiveChannelId,
      fileUrl,
      {
        supports_streaming: true,
        duration: info.duration,
        width: info.width,
        height: info.height,
        caption: captionText, // Заменили на безопасный форматированный текст
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
   * 📝 ФОРМАТИРОВАНИЕ CAPTION (Сделан PUBLIC и добавлен ESCAPE)
   */
  public formatCaption(info: VideoInfoDto): string {
    // Обязательно экранируем динамические данные от площадок!
    const cleanTitle = this.escapeHtml(info.title || 'Без названия');
    const cleanUploader = this.escapeHtml(info.uploader || 'Неизвестно');

    const views = this.formatNumber(info.viewCount || 0);
    const likes = this.formatNumber(info.likeCount || 0);
    const date = this.formatDate(info.uploadDate);
    const duration = this.formatDuration(info.duration || 0);

    return [
      `🎬 <b>${cleanTitle}</b>`,
      '',
      `👁 ${views} • 👍 ${likes}`,
      `📥 ${date} • 🕒 ${duration}`,
      `👤 ${cleanUploader}`,
    ]
      .join('\n')
      .trim();
  }

  /**
   * 🛡️ ЭКРАНИРОВАНИЕ HTML
   */
  private escapeHtml(text: string): string {
    if (!text) return '';
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  private formatNumber(num: number): string {
    if (!num) return '0';
    if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
    if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
    return num.toString();
  }

  private formatDate(dateStr: string): string {
    if (!dateStr || dateStr.length !== 8) return 'N/A';
    const year = dateStr.substring(0, 4);
    const month = dateStr.substring(4, 6);
    const day = dateStr.substring(6, 8);
    return `${day}.${month}.${year}`;
  }

  private formatDuration(seconds: number): string {
    if (!seconds) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;

    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
}