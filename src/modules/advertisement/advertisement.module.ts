// src/modules/advertisement/advertisement.module.ts

import { Module } from '@nestjs/common';
import { AdvertisementService } from './advertisement.service';
import { ClickTrackingService } from './click-tracking.service';
import { RedirectController } from './redirect.controller';
import { isBotRole } from '../../config/role';

/**
 * Редирект-маршрут поднимается только у процесса роли bot: наружу торчит
 * ровно один контейнер, и держать тот же обработчик в каждой реплике
 * воркера незачем.
 */
@Module({
  controllers: isBotRole() ? [RedirectController] : [],
  providers: [AdvertisementService, ClickTrackingService],
  exports: [AdvertisementService, ClickTrackingService],
})
export class AdvertisementModule {}
