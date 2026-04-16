import { Injectable, Logger } from '@nestjs/common';
import { Context, InputFile, Bot } from 'grammy';
import { YtdlpService } from '../ytdlp/ytdlp.service';
import { VideoInfoDto } from '../downloader/dto/video-info.dto';
import { ConfigService } from '@nestjs/config';
import * as path from 'path';
@Injectable()
export class UploaderService {
  private readonly logger = new Logger(UploaderService.name);
  private readonly archiveChannelId: string;
  private bot: Bot | null = null; // Изначально бот не установлен
  constructor(
    private ytdlpService: YtdlpService,
    private config: ConfigService,
  ) {
    // Получаем bot instance из глобального контекста или инжектим
    this.archiveChannelId = this.config.get<string>('CHANNEL_ID') || '';
  }

  // Метод для установки бота (вызывается из BotModule)
  setBot(bot: Bot) {
    this.bot = bot;
    this.logger.log(`🔧 setBot вызван. Bot defined: ${!!bot}`);
    this.logger.log(`🔧 UploaderService instance ID: ${Math.random()}`);
  }

  /**
   * 📤 ОТПРАВКА ВИДЕО С ПРЕВЬЮ И СТРИМИНГОМ
   */
  async sendVideoToUser(
    ctx: Context,
    videoPath: string,
    info: VideoInfoDto,
    caption?: string,
  ): Promise<void> {
    try {
      this.logger.log(`📤 Отправка видео: ${videoPath}`);

      // 1. Генерим превью (опционально)
      const thumbnail = await this.ytdlpService.generateThumbnail(videoPath);


      // 3. Отправляем с превью и поддержкой стриминга
      await ctx.replyWithVideo(new InputFile(videoPath), {
        thumbnail: thumbnail ? new InputFile(thumbnail) : undefined,
        supports_streaming: true, // 🔥 Главная магия
        duration: info.duration,
        width: info.width,
        height: info.height,
        caption: this.escapeHtml(caption || this.formatCaption(info)),
        parse_mode: 'HTML',
      });

      this.logger.log('✅ Видео отправлено');

      // 4. Чистим временные файлы
      await this.cleanup(videoPath, thumbnail);
    } catch (error: any) {
      this.logger.error(`❌ Ошибка отправки: ${error.message}`);
      throw error;
    }
  }

  /**
   * 📤 ОТПРАВКА АУДИО
   */
  async sendAudioToUser(
    ctx: Context,
    audioPath: string,
    info: VideoInfoDto,
  ): Promise<void> {
    try {
      this.logger.log(`📤 Отправка аудио: ${audioPath}`);

      await ctx.replyWithAudio(new InputFile(audioPath), {
        title: info.title,
        performer: info.uploader,
        duration: info.duration,
        caption: this.escapeHtml(this.formatCaption(info)),
        parse_mode: 'HTML',
      });

      this.logger.log('✅ Аудио отправлено');

      // Чистим файл
      await this.ytdlpService.safeDelete(audioPath);
    } catch (error: any) {
      this.logger.error(`❌ Ошибка отправки аудио: ${error.message}`);
      throw error;
    }
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
        this.logger.error('❌ Bot undefined! Instance ID:', Math.random());
        throw new Error(
          'Bot instance не установлен. Вызовите setBot() сначала.',
        );
      }
      const absolutePath = path.resolve(videoPath);
      this.logger.log(`🚀 Отправка через Local API: ${absolutePath}`);
      this.logger.log(`📤 Кеширование в канал: ${this.archiveChannelId}`);

      let message: any;
      const userCaption =
        `✅ ${info.title}\n\n📥 ${info.uploader}\n\n📢` +
        ` ${this.formatNumber(info.viewCount)} просмотров`;

      if (isAudio) {
        const thumbPath = this.ytdlpService.getThumbnailPath(videoPath);
        // Кешируем аудио
        message = await this.bot.api.sendAudio(
          this.archiveChannelId,
          new InputFile(videoPath),
          {
            title: info.title,
            performer: info.uploader,
            duration: info.duration,
            caption: this.escapeHtml(userCaption),
            thumbnail: thumbPath
              ? new InputFile(path.resolve(thumbPath))
              : undefined,
          },
        );
        if (thumbPath) {
          await this.ytdlpService.safeDelete(thumbPath);
        }
      } else {
        // Кешируем видео
        const thumbnailPath =
          await this.ytdlpService.generateThumbnail(videoPath);
        const absoluteThumbPath = thumbnailPath
          ? path.resolve(thumbnailPath)
          : undefined;

        message = await this.bot.api.sendVideo(
          this.archiveChannelId,
          new InputFile(absolutePath),
          {
            thumbnail: absoluteThumbPath
              ? new InputFile(absoluteThumbPath)
              : undefined,
            supports_streaming: true,
            duration: info.duration,
            width: info.width,
            height: info.height,
            caption: this.escapeHtml(userCaption),
            parse_mode: 'HTML',
          },
        );

        if (thumbnailPath) {
          await this.ytdlpService.safeDelete(thumbnailPath);
        }
      }

      const fileId = isAudio ? message.audio?.file_id : message.video?.file_id;

      if (!fileId) {
        throw new Error('Не удалось получить file_id из сообщения');
      }

      this.logger.log(
        `✅ Закешировано. FileID: ${fileId}, MessageID: ${message.message_id}`,
      );

      return {
        fileId: fileId,
        messageId: message.message_id,
      };
    } catch (error: any) {
      this.logger.error(`❌ Ошибка кеширования: ${error.message}`);
      throw error;
    }
  }

  /**
   * 🧹 ОЧИСТКА ФАЙЛОВ
   */
  private async cleanup(
    videoPath: string,
    thumbnailPath?: string | null,
  ): Promise<void> {
    await this.ytdlpService.safeDelete(videoPath);
    if (thumbnailPath) {
      await this.ytdlpService.safeDelete(thumbnailPath);
    }
  }

  /**
   * 📝 ФОРМАТИРОВАНИЕ CAPTION
   */
  private formatCaption(info: VideoInfoDto): string {
    const views = this.formatNumber(info.viewCount);
    const likes = this.formatNumber(info.likeCount);
    const date = this.formatDate(info.uploadDate);
    const duration = this.formatDuration(info.duration);

    return `
🎬 <b>${info.title}</b>

👁 ${views} • 👍 ${likes}
📥 ${date} • 🕒 ${duration}
👤 ${info.uploader}
    `.trim();
  }

  /**
   * 🛡️ ЭКРАНИРОВАНИЕ HTML
   * КРИТИЧНО для работы parse_mode: 'HTML'
   */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * 🔢 ФОРМАТИРОВАНИЕ ЧИСЕЛ
   */
  private formatNumber(num: number): string {
    if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
    if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
    return num.toString();
  }

  /**
   * 📅 ФОРМАТИРОВАНИЕ ДАТЫ
   */
  private formatDate(dateStr: string): string {
    if (!dateStr || dateStr.length !== 8) return 'N/A';

    const year = dateStr.substring(0, 4);
    const month = dateStr.substring(4, 6);
    const day = dateStr.substring(6, 8);

    return `${day}.${month}.${year}`;
  }

  /**
   * ⏱️ ФОРМАТИРОВАНИЕ ДЛИТЕЛЬНОСТИ
   */
  private formatDuration(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;

    if (h > 0)
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
}
