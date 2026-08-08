// src/app.module.ts

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import { validationSchema } from './config/validation.schema';
import { DatabaseModule } from './database/prisma.module';
import { RedisModule } from './common/redis/redis.module';
import { TelegramModule } from './modules/telegram/telegram.module';
import { UserModule } from './modules/user/user.module';
import { ChannelModule } from './modules/channel/channel.module';
import { SubscriptionModule } from './modules/subscription/subscription.module';
import { CacheModule } from './modules/cache/cache.module';
import { UploaderModule } from './modules/uploader/uploader.module';
import { DownloaderModule } from './modules/downloader/downloader.module';
import { AdvertisementModule } from './modules/advertisement/advertisement.module';
import { AdminModule } from './modules/admin/admin.module';
import { BotModule } from './modules/bot/bot.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema,
      envFilePath: [`.env.${process.env.NODE_ENV || 'development'}`, '.env'],
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('REDIS_HOST') || '127.0.0.1',
          port: config.get<number>('REDIS_PORT') || 6379,
          // Раньше повторы прекращались после трёх попыток и очередь
          // оставалась мёртвой до перезапуска процесса. Теперь переподключение
          // бесконечное, с нарастающей паузой: моргнувший Redis чинится сам.
          retryStrategy: (times: number) => Math.min(times * 500, 10_000),
          maxRetriesPerRequest: null,
        },
        defaultJobOptions: {
          removeOnComplete: true,
          // Провалившиеся задачи копились в Redis без ограничения —
          // держим только последние
          removeOnFail: 500,
        },
      }),
    }),
    ScheduleModule.forRoot(),

    RedisModule,
    TelegramModule,
    DatabaseModule,

    UserModule,
    ChannelModule,
    SubscriptionModule,
    CacheModule,
    UploaderModule,
    DownloaderModule,
    AdvertisementModule,
    AdminModule,
    BotModule,
    HealthModule,
  ],
})
export class AppModule {}
