// src/modules/bot/bot.module.ts

import { Module } from '@nestjs/common';
import { BotService } from './bot.service';
import { BotUpdate } from './bot.update';
import { UserModule } from '../user/user.module';
import { SubscriptionModule } from '../subscription/subscription.module';
import { ChannelModule } from '../channel/channel.module';
import { DownloaderModule } from '../downloader/downloader.module';
import { AdminModule } from '../admin/admin.module';

/**
 * Экземпляр бота живёт в TelegramModule (глобальном), поэтому здесь больше
 * нет ни NestjsGrammyModule, ни forwardRef между Bot / Downloader / Uploader:
 * циклов зависимостей просто не возникает.
 */
@Module({
  imports: [
    UserModule,
    SubscriptionModule,
    ChannelModule,
    DownloaderModule,
    AdminModule,
  ],
  providers: [BotService, BotUpdate],
  exports: [BotService],
})
export class BotModule {}
