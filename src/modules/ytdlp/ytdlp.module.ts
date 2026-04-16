// ytdlp.module.ts (НОВЫЙ ФАЙЛ)
import { Module } from '@nestjs/common';
import { YtdlpService } from './ytdlp.service';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [ConfigModule],
  providers: [YtdlpService],
  exports: [YtdlpService], 
})
export class YtdlpModule {}