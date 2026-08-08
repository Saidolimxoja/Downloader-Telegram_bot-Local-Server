// src/modules/cache/cache.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { CachedFile } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { generateCacheKey } from '../../common/utils/file.utils';

/** Данные для записи файла в кеш */
export interface CacheEntryDto {
  /** Идентификатор видео на площадке — основа ключа кеша */
  url: string;
  formatId: string;
  resolution: string;
  fileId: string;
  archiveMessageId: number;
  fileSize: bigint;
  fileType: 'video' | 'audio' | 'album';
  userId: bigint;
  title: string;
  uploader?: string;
  duration?: number;
}

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);

  /**
   * 🧠 Горячий кеш в памяти поверх БД.
   *
   * Раньше эта Map росла без ограничений: каждое новое видео добавляло объект
   * CachedFile и не удаляло ничего. На дистанции в тысячи роликов это сотни
   * мегабайт в каждом процессе. Теперь честный LRU: при переполнении вылетает
   * запись, к которой дольше всего не обращались (Map хранит порядок вставки,
   * а при попадании мы переставляем ключ в конец).
   */
  private memoryCache = new Map<string, CachedFile>();
  private static readonly MAX_MEMORY_ENTRIES = 1000;

  constructor(private prisma: PrismaService) {}

  /**
   * Получить один файл из кеша
   */
  async get(
    url: string,
    formatId: string,
    resolution: string,
  ): Promise<CachedFile | null> {
    const cacheKey = generateCacheKey(url, formatId, resolution);

    const memoryCached = this.memoryCache.get(cacheKey);
    if (memoryCached) {
      this.touch(cacheKey, memoryCached);
      this.updateCacheStatsAsync(memoryCached.id);
      return memoryCached;
    }

    const dbCached = await this.prisma.cachedFile.findUnique({
      where: { cacheKey },
    });

    if (dbCached) {
      this.touch(cacheKey, dbCached);
      this.updateCacheStatsAsync(dbCached.id);
      return dbCached;
    }

    return null;
  }

  /**
   * ⚡ ПАКЕТНАЯ ПРОВЕРКА НАЛИЧИЯ В КЕШЕ
   *
   * Клавиатура выбора качества показывает значок ⚡ у форматов, которые уже
   * лежат в кеше. Раньше на каждый формат уходил отдельный SELECT — 5-8
   * запросов к Postgres на один клик по ссылке. Теперь один запрос на всё.
   *
   * Возвращает множество ключей (formatId|resolution), которые есть в кеше.
   */
  async getCachedVariants(
    url: string,
    variants: Array<{ formatId: string; resolution: string }>,
  ): Promise<Set<string>> {
    if (variants.length === 0) return new Set();

    const keyByCacheKey = new Map<string, string>();
    for (const variant of variants) {
      const cacheKey = generateCacheKey(
        url,
        variant.formatId,
        variant.resolution,
      );
      keyByCacheKey.set(cacheKey, `${variant.formatId}|${variant.resolution}`);
    }

    try {
      const rows = await this.prisma.cachedFile.findMany({
        where: { cacheKey: { in: Array.from(keyByCacheKey.keys()) } },
        select: { cacheKey: true },
      });

      const found = new Set<string>();
      for (const row of rows) {
        const variantKey = keyByCacheKey.get(row.cacheKey);
        if (variantKey) found.add(variantKey);
      }

      return found;
    } catch (error: any) {
      // Значки ⚡ — украшение, а не функциональность: при сбое просто не рисуем
      this.logger.warn(
        `⚠️ Пакетная проверка кеша не удалась: ${error.message}`,
      );
      return new Set();
    }
  }

  /**
   * Сохранить в кеш
   */
  async set(data: CacheEntryDto): Promise<CachedFile> {
    const cacheKey = generateCacheKey(data.url, data.formatId, data.resolution);

    const cached = await this.prisma.cachedFile.upsert({
      where: { cacheKey },
      update: {
        fileId: data.fileId,
        archiveMessageId: data.archiveMessageId,
      },
      create: {
        cacheKey,
        originalUrl: data.url,
        formatId: data.formatId,
        resolution: data.resolution,
        fileId: data.fileId,
        archiveMessageId: data.archiveMessageId,
        title: data.title,
        uploader: data.uploader || null,
        duration: data.duration || null,
        fileSize: data.fileSize || 0n,
        fileType: data.fileType,
        // userId ссылается на реальную запись в users. Для сообщений без
        // автора (посты канала) он приходит нулевым — тогда оставляем пустым,
        // иначе внешний ключ отвалится и весь кеш не сохранится
        userId: data.userId > 0n ? data.userId : null,
      },
    });

    this.touch(cacheKey, cached);
    return cached;
  }

  /** Записать факт выдачи файла из кеша */
  async recordCacheHit(cachedFileId: number, userId: bigint): Promise<void> {
    await this.recordDownloadEntry(cachedFileId, userId, true);
  }

  /** Записать факт свежей загрузки */
  async recordDownload(cachedFileId: number, userId: bigint): Promise<void> {
    await this.recordDownloadEntry(cachedFileId, userId, false);
  }

  /**
   * История загрузок — статистика, а не бизнес-логика. Если пользователя нет
   * в таблице users (написал боту, ни разу не нажав /start), внешний ключ
   * отвалится — это не повод ронять выдачу уже готового файла.
   */
  private async recordDownloadEntry(
    cachedFileId: number,
    userId: bigint,
    wasFromCache: boolean,
  ): Promise<void> {
    if (userId <= 0n) return;

    try {
      await this.prisma.download.create({
        data: { cachedFileId, userId, wasFromCache },
      });
    } catch (error: any) {
      this.logger.warn(
        `⚠️ Не удалось записать историю загрузки: ${error.message}`,
      );
    }
  }

  async getStats() {
    const [total, totalSize] = await this.prisma.$transaction([
      this.prisma.cachedFile.count(),
      this.prisma.cachedFile.aggregate({ _sum: { fileSize: true } }),
    ]);

    return {
      totalFiles: total,
      totalSizeBytes: totalSize._sum.fileSize || 0n,
      memoryCacheSize: this.memoryCache.size,
    };
  }

  /**
   * Очистить давно не используемые записи
   */
  async cleanOldCache(daysOld = 30): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    const result = await this.prisma.cachedFile.deleteMany({
      where: { lastAccessedAt: { lt: cutoffDate } },
    });

    // Память чистим целиком: выяснять, какие именно ключи удалились,
    // дороже, чем один раз прогреть кеш заново
    if (result.count > 0) this.memoryCache.clear();

    this.logger.log(`🗑️ Удалено ${result.count} старых записей`);
    return result.count;
  }

  /**
   * Обновление счётчиков в фоне — пользователь не ждёт этот запрос
   */
  private updateCacheStatsAsync(cachedFileId: number): void {
    this.prisma.cachedFile
      .update({
        where: { id: cachedFileId },
        data: {
          lastAccessedAt: new Date(),
          downloadCount: { increment: 1 },
        },
      })
      .catch((err: Error) =>
        this.logger.warn(`⚠️ Не удалось обновить статистику: ${err.message}`),
      );
  }

  /**
   * Положить запись в конец LRU и вытеснить самую старую при переполнении
   */
  private touch(cacheKey: string, value: CachedFile): void {
    this.memoryCache.delete(cacheKey);
    this.memoryCache.set(cacheKey, value);

    while (this.memoryCache.size > CacheService.MAX_MEMORY_ENTRIES) {
      const oldest = this.memoryCache.keys().next();
      if (oldest.done) break;
      this.memoryCache.delete(oldest.value);
    }
  }
}
