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

      if (isAudio) {
        thumbnailPath = this.ytdlpService.getThumbnailPath(videoPath);
        message = await this.bot.api.sendAudio(
          this.archiveChannelId,
          new InputFile(absolutePath),
          {
            title: info.title,
            performer: info.uploader,
            duration: info.duration,
            caption: this.escapeHtml(`✅ ${info.title}\n👤 ${info.uploader}`),
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
            caption: this.escapeHtml(`✅ ${info.title}\n👤 ${info.uploader}`),
            thumbnail: thumbnailPath
              ? new InputFile(path.resolve(thumbnailPath))
              : undefined,
            parse_mode: 'HTML',
          },
        );
      }

      let fileId: string | undefined;

      if (isAudio && message.audio) {
        fileId = message.audio.file_id;
      } else if (!isAudio && message.video) {
        fileId = message.video.file_id;
      }

      if (!fileId) {
        this.logger.error(`❌ Не удалось получить file_id. Тип: ${isAudio ? 'audio' : 'video'}, Ответ: ${JSON.stringify(message)}`);
        throw new Error('Не удалось получить file_id из ответа Telegram API');
      }

      if (thumbnailPath) {
        await this.ytdlpService.safeDelete(thumbnailPath).catch(() => {});
      }

      this.logger.log(
        `✅ Закешировано успешно. MessageID: ${message.message_id}`,
      );

      return {
        fileId,
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
