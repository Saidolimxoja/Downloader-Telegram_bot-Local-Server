import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CacheService } from './cache.service';

/**
 * Кеш файлов вечный и автоматически не чистится: запись — это всего лишь
 * fileId уже загруженного в архивный канал видео (сотни байт), а её удаление
 * заставляло бы заново качать и заливать ролик, который давно лежит в Telegram.
 */
@Injectable()
export class CacheStatsService {
  private readonly logger = new Logger(CacheStatsService.name);

  constructor(private cacheService: CacheService) {}

  /**
   * Статистика кеша (раз в неделю, в ночь на воскресенье)
   */
  @Cron(CronExpression.EVERY_WEEK)
  async logCacheStats() {
    this.logger.log('📊 Статистика кеша...');

    try {
      const stats = await this.cacheService.getStats();

      const totalSizeMB = Number(stats.totalSizeBytes) / (1024 * 1024);

      this.logger.log(
        `📊 Кеш: ${stats.totalFiles} файлов, ${totalSizeMB.toFixed(2)} MB, ` +
          `${stats.memoryCacheSize} в памяти`,
      );
    } catch (error: any) {
      this.logger.error(`❌ Ошибка получения статистики: ${error.message}`);
    }
  }
}
