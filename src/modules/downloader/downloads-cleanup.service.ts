// src/modules/downloader/downloads-cleanup.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * 🧹 УБОРКА ВРЕМЕННЫХ ФАЙЛОВ
 *
 * Обычный путь удаляет файл сразу после отправки. Но если процесс убили,
 * yt-dlp упал на таймауте или ffmpeg отвалился — на диске остаётся мусор,
 * и убрать его было некому. При файлах до двух гигабайт это вопрос недель
 * до заполнения диска и остановки всего сервиса.
 *
 * Раз в час проходим по папке загрузок и удаляем всё, что старше порога:
 * живая загрузка столько не длится (её ограничивает таймаут yt-dlp).
 */
@Injectable()
export class DownloadsCleanupService {
  private readonly logger = new Logger(DownloadsCleanupService.name);
  private readonly downloadsDir: string;
  private readonly maxAgeMs: number;

  constructor(config: ConfigService) {
    this.downloadsDir = config.get<string>('DOWNLOADS_DIR') || './downloads';
    this.maxAgeMs =
      (config.get<number>('ORPHAN_FILE_MAX_AGE_MINUTES') ?? 120) * 60 * 1000;
  }

  @Cron(CronExpression.EVERY_HOUR)
  async cleanOrphanFiles(): Promise<void> {
    let entries: string[];

    try {
      entries = await fs.readdir(this.downloadsDir);
    } catch (error: any) {
      this.logger.warn(`⚠️ Папка загрузок недоступна: ${error.message}`);
      return;
    }

    const cutoff = Date.now() - this.maxAgeMs;
    let removed = 0;
    let freedBytes = 0;

    for (const entry of entries) {
      const filepath = path.join(this.downloadsDir, entry);

      try {
        const stats = await fs.stat(filepath);
        if (!stats.isFile() || stats.mtimeMs > cutoff) continue;

        await fs.unlink(filepath);
        removed++;
        freedBytes += stats.size;
      } catch {
        // Файл могли удалить прямо сейчас — это нормальный исход гонки
      }
    }

    if (removed > 0) {
      const freedMb = (freedBytes / (1024 * 1024)).toFixed(1);
      this.logger.log(
        `🧹 Удалено ${removed} забытых файлов, освобождено ${freedMb} МБ`,
      );
    }
  }

  /** Сколько сейчас занимает папка загрузок — для /health */
  async getDiskUsage(): Promise<{ files: number; bytes: number }> {
    try {
      const entries = await fs.readdir(this.downloadsDir);
      let bytes = 0;
      let files = 0;

      for (const entry of entries) {
        try {
          const stats = await fs.stat(path.join(this.downloadsDir, entry));
          if (!stats.isFile()) continue;
          bytes += stats.size;
          files++;
        } catch {
          // пропускаем исчезнувшие файлы
        }
      }

      return { files, bytes };
    } catch {
      return { files: 0, bytes: 0 };
    }
  }
}
