import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from './database/prisma.module';
import { UserModule } from './modules/user/user.module';
import { ChannelModule } from './modules/channel/channel.module';
import { validationSchema } from './config/validation.schema';
import { AdminModule } from './modules/admin/admin.module';
import { AdvertisementModule } from './modules/advertisement/advertisement.module';
import { BotModule } from './modules/bot/bot.module';
import { CacheModule } from './modules/cache/cache.module';
import { DownloaderModule } from './modules/downloader/downloader.module';
import { SubscriptionModule } from './modules/subscription/subscription.module';
import { UploaderModule } from './modules/uploader/uploader.module';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config'; // Добавь ConfigService
import { NestjsGrammyModule } from '@grammyjs/nestjs'; // 👈 ДОБАВЬ ЭТО

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema,
      envFilePath: [
        `.env.${process.env.NODE_ENV || 'development'}`,
        '.env',
      ],
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get('REDIS_HOST') || '127.0.0.1',
          port: config.get<number>('REDIS_PORT') || 6379,
          retryStrategy: (times) => {
            if (times > 3) {
              return null;
            }
            return Math.min(times * 100, 3000);
          },
        },
      }),
    }),
    ScheduleModule.forRoot(),
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
  ],
})
export class AppModule {}
