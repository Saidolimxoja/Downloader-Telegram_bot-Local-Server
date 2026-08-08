// src/modules/downloader/downloader.module.ts

import { Module, Provider } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { DownloaderService } from './downloader.service';
import { AnalysisService } from './analysis.service';
import { DownloadExecutorService } from './download-executor.service';
import { MediaDeliveryService } from './media-delivery.service';
import { RateLimitService } from './rate-limit.service';
import { DownloadProcessor } from './download.processor';
import { AnalyzeProcessor } from './analyze.processor';
import { DownloadsCleanupService } from './downloads-cleanup.service';
import { VideoSessionService } from './video-session/video-session.service';
import { VideoSessionCleanupService } from './video-session/video-session-cleanup.service';
import { YtdlpModule } from '../ytdlp/ytdlp.module';
import { CacheModule } from '../cache/cache.module';
import { UploaderModule } from '../uploader/uploader.module';
import { UserModule } from '../user/user.module';
import { AdvertisementModule } from '../advertisement/advertisement.module';
import {
  ANALYZE_QUEUE,
  DOWNLOAD_QUEUE,
} from './interfaces/download-job.interface';
import { isCronRole, isWorkerRole } from '../../config/role';

/**
 * Воркеры очередей поднимаются только там, где процессу положено их разбирать.
 * Иначе процесс роли «bot» тоже начал бы качать видео — ровно то, от чего мы
 * уходим: тяжёлый ffmpeg рядом с long-polling.
 */
const workerProviders: Provider[] = isWorkerRole()
  ? [DownloadProcessor, AnalyzeProcessor]
  : [];

/**
 * Периодические задачи — только на одном процессе. Воркеров может быть пять,
 * и пять параллельных уборок диска не нужны никому.
 */
const cronProviders: Provider[] = isCronRole()
  ? [DownloadsCleanupService, VideoSessionCleanupService]
  : [];

@Module({
  imports: [
    // Обе очереди регистрируются в любой роли: боту нужно класть задачи,
    // воркеру — забирать
    BullModule.registerQueue({ name: ANALYZE_QUEUE }),
    BullModule.registerQueue({ name: DOWNLOAD_QUEUE }),
    // Импортируем модуль, а не объявляем YtdlpService провайдером заново:
    // иначе в приложении жили бы два независимых экземпляра сервиса —
    // один здесь, второй у UploaderModule
    YtdlpModule,
    CacheModule,
    UploaderModule,
    UserModule,
    AdvertisementModule,
  ],
  providers: [
    DownloaderService,
    AnalysisService,
    DownloadExecutorService,
    MediaDeliveryService,
    RateLimitService,
    VideoSessionService,
    ...workerProviders,
    ...cronProviders,
  ],
  exports: [DownloaderService, VideoSessionService],
})
export class DownloaderModule {}
