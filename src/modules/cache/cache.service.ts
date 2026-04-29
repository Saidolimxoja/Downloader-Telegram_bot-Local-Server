import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { CachedFile } from '@prisma/client';
import { generateCacheKey } from '../../common/utils/file.utils';

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  private memoryCache = new Map<string, CachedFile>();

  constructor(private prisma: PrismaService) {}

  /**
   * Получить из кеша
   */
  async get(
    url: string,
    formatId: string,
    resolution: string,
  ): Promise<CachedFile | null> {
    const cacheKey = generateCacheKey(url, formatId, resolution);

    // Сначала проверяем memory cache
    const memoryCached = this.memoryCache.get(cacheKey);
    if (memoryCached) {
      this.logger.log(`⚡ Memory cache HIT: ${resolution}`);
      return memoryCached;
    }

    // Затем проверяем БД
    const dbCached = await this.prisma.cachedFile.findUnique({
      where: { cacheKey },
    });

    if (dbCached) {
      this.logger.log(`💾 DB cache HIT: ${resolution}`);
      // Сохраняем в memory cache
      this.memoryCache.set(cacheKey, dbCached);

      // Обновляем lastAccessedAt и downloadCount
      await this.prisma.cachedFile.update({
        where: { id: dbCached.id },
        data: {
          lastAccessedAt: new Date(),
          downloadCount: { increment: 1 },
        },
      });

      return dbCached;
    }

    this.logger.log(`❌ Cache MISS: ${resolution}`);
    return null;
  }

  /**
   * Сохранить в кеш
   */
  async set(data: any) {
    // Генерируем ключ (он должен быть помечен как @unique в schema.prisma)
    const cacheKey = generateCacheKey(data.url, data.formatId, data.resolution);

    this.logger.log(`💾 Сохранение в кеш: ${data.resolution}`);

    const cached = await this.prisma.cachedFile.upsert({
      where: {
        cacheKey: cacheKey, // Используем уникальный строковый ключ для поиска
      },
      update: {
        // Если запись нашлась, обновляем только ID файлов
        fileId: data.fileId,
        archiveMessageId: data.archiveMessageId,
      },
      create: {
        // Если записи нет, создаем новую
        cacheKey: cacheKey,
        originalUrl: data.url, // В схеме поле называется originalUrl
        formatId: data.formatId,
        resolution: data.resolution,
        fileId: data.fileId,
        archiveMessageId: data.archiveMessageId,
        title: data.title,
        uploader: data.uploader || null,
        duration: data.duration || null,
        fileSize: data.fileSize || 0n,
        fileType: data.fileType,
        userId: data.userId,
        downloads: {
          create: {
            userId: data.userId ?? null,
            wasFromCache: false,
          },
        },
      },
    });

    // Сохраняем в memory cache
    this.memoryCache.set(cacheKey, cached);

    return cached;
  }

  /**
   * Записать загрузку из кеша
   */
  async recordCacheHit(cachedFileId: number, userId: bigint): Promise<void> {
    await this.prisma.download.create({
      data: {
        cachedFileId,
        userId,
        wasFromCache: true,
      },
    });
  }

  /**
   * Получить статистику кеша
   */
  async getStats() {
    const total = await this.prisma.cachedFile.count();
    const totalSize = await this.prisma.cachedFile.aggregate({
      _sum: { fileSize: true },
    });

    return {
      totalFiles: total,
      totalSizeBytes: totalSize._sum.fileSize || BigInt(0),
      memoryCacheSize: this.memoryCache.size,
    };
  }

  /**
   * Очистить старые записи
   */
  async cleanOldCache(daysOld = 30): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    const result = await this.prisma.cachedFile.deleteMany({
      where: {
        lastAccessedAt: {
          lt: cutoffDate,
        },
      },
    });

    this.logger.log(`🗑️ Удалено ${result.count} старых записей`);
    return result.count;
  }
}
