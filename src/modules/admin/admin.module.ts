import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminScene } from './admin.scene';
import { UserModule } from '../user/user.module';
import { AdvertisementModule } from '../advertisement/advertisement.module';
import { ChannelModule } from '../channel/channel.module';
import { CacheModule } from '../cache/cache.module';

@Module({
  imports: [UserModule, AdvertisementModule, ChannelModule ,CacheModule],
  providers: [AdminService, AdminScene],
  exports: [AdminService, AdminScene],
})
export class AdminModule {} 