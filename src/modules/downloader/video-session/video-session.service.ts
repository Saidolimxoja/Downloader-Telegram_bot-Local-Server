import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { VideoInfoDto } from '../dto/video-info.dto';

@Injectable()
export class VideoSessionService {
  private readonly logger = new Logger(VideoSessionService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * 💾 Сохранить сессию видео
   */
  async save(videoId: string, videoInfo: VideoInfoDto): Promise<void> {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // 7 дней

    try {
      await this.prisma.videoSession.create({
        data: {
          id: videoId,
          originalUrl: videoInfo.url || '',
          videoId: videoInfo.id,
          title: videoInfo.title,
          uploader: videoInfo.uploader,
          duration: videoInfo.duration,
          viewCount: videoInfo.viewCount ? BigInt(videoInfo.viewCount) : null,
          likeCount: videoInfo.likeCount ? BigInt(videoInfo.likeCount) : null,
          uploadDate: videoInfo.uploadDate,
          thumbnail: videoInfo.thumbnail,
          formats: JSON.stringify(videoInfo.formats), // Сохраняем как JSON
          expiresAt,
        },
      });

      this.logger.log(`💾 Сохранена сессия видео: ${videoId}`);
    } catch (error:any) {
      this.logger.error(`❌ Ошибка сохранения сессии: ${error.message}`);
      throw error;
    }
  }

  /**
   * 📥 Получить сессию видео
   */
  async get(videoId: string): Promise<VideoInfoDto | null> {
    try {
      const session = await this.prisma.videoSession.findUnique({
        where: { id: videoId },
      });

      if (!session) {
        this.logger.debug(`❌ Сессия не найдена: ${videoId}`);
        return null;
      }

      // Проверяем не истекла ли сессия
      if (new Date() > session.expiresAt) {
        this.logger.debug(`⏰ Сессия истекла: ${videoId}`);
        await this.delete(videoId);
        return null;
      }

      // Парсим форматы из JSON
      const formats = JSON.parse(session.formats as string);

      return {
        id: session.videoId,
        url: session.originalUrl,
        title: session.title,
        uploader: session.uploader|| '',
        duration: session.duration || 0,
        viewCount: session.viewCount ? Number(session.viewCount) : 0,
        likeCount: session.likeCount ? Number(session.likeCount) : 0,
        uploadDate: session.uploadDate || '',
        thumbnail: session.thumbnail || '',
        width: 0,  // 🆕 Дефолтные значения (не сохраняем в БД)
        height: 0, // 🆕 Будут перезаписаны при реальном скачивании
        formats,
      };
    } catch (error:any) {
      this.logger.error(`❌ Ошибка получения сессии: ${error.message}`);
      return null;
    }
  }

  /**
   * 🗑️ Удалить сессию
   */
  async delete(videoId: string): Promise<void> {
    try {
      await this.prisma.videoSession.delete({
        where: { id: videoId },
      });
      this.logger.debug(`🗑️ Удалена сессия: ${videoId}`);
    } catch (error:any) {
      // Игнорируем ошибку если запись уже удалена
      if (error.code !== 'P2025') {
        this.logger.error(`❌ Ошибка удаления сессии: ${error.message}`);
      }
    }
  }

  /**
   * 🧹 Очистить истёкшие сессии (вызывать по крону)
   */
  async cleanExpired(): Promise<number> {
    try {
      const result = await this.prisma.videoSession.deleteMany({
        where: {
          expiresAt: {
            lt: new Date(),
          },
        },
      });

      if (result.count > 0) {
        this.logger.log(`🗑️ Удалено ${result.count} истёкших видео-сессий`);
      }

      return result.count;
    } catch (error:any) {
      this.logger.error(`❌ Ошибка очистки сессий: ${error.message}`);
      return 0;
    }
  }

  /**
   * 📊 Получить статистику сессий
   */
  async getStats(): Promise<{
    total: number;
    expired: number;
    active: number;
  }> {
    try {
      const total = await this.prisma.videoSession.count();
      const expired = await this.prisma.videoSession.count({
        where: { expiresAt: { lt: new Date() } },
      });

      return {
        total,
        expired,
        active: total - expired,
      };
    } catch (error:any) {
      this.logger.error(`❌ Ошибка получения статистики: ${error.message}`);
      return { total: 0, expired: 0, active: 0 };
    }
  }
}