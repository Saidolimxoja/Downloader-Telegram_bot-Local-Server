// src/modules/premium/premium.module.ts

import { Global, Module } from '@nestjs/common';
import { PremiumService } from './premium.service';
import { ReferralService } from './referral.service';

/**
 * Глобальный: статус премиума проверяется в лимитах, рекламе, проверке
 * подписки и приоритете очереди — то есть почти везде.
 */
@Global()
@Module({
  providers: [PremiumService, ReferralService],
  exports: [PremiumService, ReferralService],
})
export class PremiumModule {}
