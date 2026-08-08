// src/modules/health/health.module.ts

import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { HealthController } from './health.controller';
import {
  ANALYZE_QUEUE,
  DOWNLOAD_QUEUE,
} from '../downloader/interfaces/download-job.interface';

@Module({
  imports: [
    BullModule.registerQueue({ name: ANALYZE_QUEUE }),
    BullModule.registerQueue({ name: DOWNLOAD_QUEUE }),
  ],
  controllers: [HealthController],
})
export class HealthModule {}
