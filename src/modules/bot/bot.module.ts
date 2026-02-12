// src/modules/bot/bot.module.ts

import { Module } from '@nestjs/common';
import { BotService } from './bot.service';
import { BotUpdate } from './bot.update';
import { UserModule } from '../user/user.module';
import { SubscriptionModule } from '../subscription/subscription.module';
import { DownloaderModule } from '../downloader/downloader.module';
import { AdminModule } from '../admin/admin.module'; // ← Добавили
import { UploaderService } from '../uploader/uploader.service';
import { YtdlpService } from '../ytdlp/ytdlp.service';
import { YtdlpModule } from '../ytdlp/ytdlp.module';
import { UploaderModule } from '../uploader/uploader.module';

@Module({
  imports: [
    UserModule,
    SubscriptionModule,
    DownloaderModule,
    AdminModule,
    YtdlpModule ,
    UploaderModule
  ],
  providers: [BotService, BotUpdate, ],
  exports: [BotService, ],
})
export class BotModule {}
