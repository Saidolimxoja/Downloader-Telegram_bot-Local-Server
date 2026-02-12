// ytdlp.module.ts (НОВЫЙ ФАЙЛ)
import { Module } from '@nestjs/common';
import { YtdlpService } from './ytdlp.service';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [ConfigModule],
  providers: [YtdlpService],
  exports: [YtdlpService], // 👈 Экспортируем для использования в других модулях
})
export class YtdlpModule {}