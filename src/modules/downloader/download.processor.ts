// src/modules/downloader/download.processor.ts

import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { DownloadExecutorService } from './download-executor.service';
import {
  DOWNLOAD_QUEUE,
  DownloadJobData,
} from './interfaces/download-job.interface';

/**
 * ⬇️ ВОРКЕР ЗАГРУЗОК
 *
 * Число одновременных загрузок задаётся через MAX_PARALLEL_DOWNLOADS.
 * Это тяжёлые задачи: yt-dlp плюс, для коротких видео, ffmpeg — каждая
 * способна занять ядро целиком. Именно поэтому воркер вынесен в отдельный
 * процесс: раньше он делил event loop с long-polling бота, и во время
 * перекодировки бот отвечал с задержкой в секунды.
 */
@Processor(DOWNLOAD_QUEUE, {
  concurrency: parseInt(process.env.MAX_PARALLEL_DOWNLOADS ?? '3', 10),
})
export class DownloadProcessor extends WorkerHost {
  private readonly logger = new Logger(DownloadProcessor.name);

  constructor(private readonly executor: DownloadExecutorService) {
    super();
  }

  async process(job: Job<DownloadJobData>): Promise<void> {
    const started = Date.now();

    try {
      await this.executor.execute(job.data);

      this.logger.log(
        `✅ Задача ${job.id} выполнена за ${Math.round((Date.now() - started) / 1000)}с`,
      );
    } catch (error: any) {
      // Пробрасываем дальше: без этого BullMQ считал задачу успешной и
      // настройка attempts не работала вообще
      this.logger.error(
        `❌ Задача ${job.id} (попытка ${job.attemptsMade + 1}): ${error.message}`,
      );
      throw error;
    }
  }
}
