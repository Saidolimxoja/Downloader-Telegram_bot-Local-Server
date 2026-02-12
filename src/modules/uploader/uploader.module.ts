import { Global, Module } from '@nestjs/common';
import { UploaderService } from './uploader.service';
import { YtdlpModule } from '../ytdlp/ytdlp.module';
import { ConfigModule } from '@nestjs/config';

@Global()
@Module({
  imports: [YtdlpModule, ConfigModule],
  providers: [UploaderService],
  exports: [UploaderService],
})
export class UploaderModule {}
