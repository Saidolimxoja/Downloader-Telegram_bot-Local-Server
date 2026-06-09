import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { DownloaderService } from './downloader.service';

@Processor('download-queue', {
  // Число параллельных загрузок задаётся через env MAX_PARALLEL_DOWNLOADS
  // (по умолчанию 3), чтобы крутить под мощность сервера без правок кода
  concurrency: parseInt(process.env.MAX_PARALLEL_DOWNLOADS ?? '3', 10),
})
export class DownloadProcessor extends WorkerHost {
  private readonly logger = new Logger(DownloadProcessor.name);

  constructor(
    private readonly downloaderService: DownloaderService, // Оставляем только сервис
  ) {
    super();
  }

  async process(job: Job<any>): Promise<any> {
    const {
      chatId,
      userId,
      videoData,
      formatId,
      resolution,
      isAudio,
      isInstagram,
      isDirect,
      queueMsgId,
    } = job.data;

    try {
      if (isDirect) {
        // Прямое скачивание (Instagram / YouTube Shorts) — без выбора качества
        await this.downloaderService.executeDirectDownloadLogic(
          chatId,
          BigInt(userId),
          videoData,
          isInstagram,
          queueMsgId,
        );
      } else {
        // Обычное скачивание с выбранным качеством
        await this.downloaderService.executeDownloadLogic(
          chatId,
          BigInt(userId),
          videoData,
          formatId,
          resolution,
          isAudio,
          isInstagram,
        );
      }
    } catch (error) {
      const err = error as Error;
      this.logger.error(`Ошибка в задании ${job.id}: ${err.message}`);
      throw error;
    }
  }
}
