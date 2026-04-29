import { Module, forwardRef } from '@nestjs/common';
import { NestjsGrammyModule } from '@grammyjs/nestjs'; // 👈 ИСПРАВЛЕНО
import { BotService } from './bot.service';
import { BotUpdate } from './bot.update';
import { UserModule } from '../user/user.module';
import { SubscriptionModule } from '../subscription/subscription.module';
import { DownloaderModule } from '../downloader/downloader.module';
import { AdminModule } from '../admin/admin.module';
import { YtdlpModule } from '../ytdlp/ytdlp.module';
import { UploaderModule } from '../uploader/uploader.module';
import { ConfigService } from '@nestjs/config';

@Module({
  imports: [
    NestjsGrammyModule.forRootAsync({
      useFactory: (config: ConfigService) => ({
        token: config.get<string>('BOT_TOKEN'),
      }),
      inject: [ConfigService],
    }),
    UserModule,
    SubscriptionModule,
    forwardRef(() => DownloaderModule), // 👈 Используй forwardRef здесь
    AdminModule,
    YtdlpModule,
    forwardRef(() => UploaderModule), // Если в Uploader тоже нужен бот
  ],
  providers: [BotService, BotUpdate],
  exports: [BotService, NestjsGrammyModule], // 👈 Теперь NestjsGrammyModule экспортируется корректно
})
export class BotModule {}
