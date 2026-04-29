import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { DownloaderService } from './downloader.service';

@Processor('download-queue', {
  concurrency: 2,
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
    } = job.data;

    try {
      // Просто вызываем метод сервиса
      await this.downloaderService.executeDownloadLogic(
        chatId,
        BigInt(userId),
        videoData,
        formatId,
        resolution,
        isAudio,
        isInstagram,
      );
    } catch (error) {
      this.logger.error(`Ошибка в задании ${job.id}: ${error.message}`);
      throw error;
    }
  }
}
