// src/modules/cache/cache.module.ts

import { Module, Provider } from '@nestjs/common';
import { CacheService } from './cache.service';
import { CacheCleanupService } from './cache-cleanup.service';
import { isCronRole } from '../../config/role';

// Ночная чистка кеша должна выполняться один раз, а не в каждой реплике воркера
const cronProviders: Provider[] = isCronRole() ? [CacheCleanupService] : [];

@Module({
  providers: [CacheService, ...cronProviders],
  exports: [CacheService],
})
export class CacheModule {}
