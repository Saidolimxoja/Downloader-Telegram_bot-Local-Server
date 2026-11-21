// src/modules/cache/cache.module.ts

import { Module, Provider } from '@nestjs/common';
import { CacheService } from './cache.service';
import { CacheStatsService } from './cache-stats.service';
import { isCronRole } from '../../config/role';

// Еженедельная статистика кеша должна логироваться один раз, а не в каждой реплике воркера
const cronProviders: Provider[] = isCronRole() ? [CacheStatsService] : [];

@Module({
  providers: [CacheService, ...cronProviders],
  exports: [CacheService],
})
export class CacheModule {}
