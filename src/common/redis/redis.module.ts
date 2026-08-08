// src/common/redis/redis.module.ts

import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';

/**
 * Глобальный: Redis нужен почти каждому модулю (лимиты, кеши, блокировки),
 * импортировать его в десяти местах — лишний шум.
 */
@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
