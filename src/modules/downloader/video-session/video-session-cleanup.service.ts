// src/modules/downloader/video-session-cleanup.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { VideoSessionService } from './video-session.service';

@Injectable()
export class VideoSessionCleanupService {
  private readonly logger = new Logger(VideoSessionCleanupService.name);

  constructor(private videoSessionService: VideoSessionService) {}

  /**
   * Очистка истёкших видео-сессий (каждый день в 4:00)
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async cleanExpiredSessions() {
    this.logger.log('🗑️ Запуск очистки истёкших видео-сессий...');

    try {
      const deleted = await this.videoSessionService.cleanExpired();

      if (deleted > 0) {
        this.logger.log(`✅ Удалено ${deleted} истёкших сессий`);
      } else {
        this.logger.log('✅ Нет истёкших сессий');
      }
    } catch (error: any) {
      this.logger.error(`❌ Ошибка очистки сессий: ${error.message}`);
    }
  }
}
