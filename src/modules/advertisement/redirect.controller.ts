// src/modules/advertisement/redirect.controller.ts

import { Controller, Get, Logger, Param, Res } from '@nestjs/common';
import { Response } from 'express';
import { AdvertisementService } from './advertisement.service';
import { ClickTrackingService } from './click-tracking.service';

/**
 * ↪️ РЕДИРЕКТ ПО РЕКЛАМНОЙ ССЫЛКЕ
 *
 * Единственный публично доступный маршрут приложения. Открывается из кнопки
 * объявления: фиксируем переход и отправляем человека к рекламодателю.
 *
 * Куда перенаправлять, берём ИЗ БАЗЫ по идентификатору объявления, а не из
 * параметра запроса. Иначе получился бы открытый редиректор: любой мог бы
 * рассылать ссылки вида saidolimxoja.uz/r?url=фишинговый-сайт, прикрываясь
 * вашим доменом.
 */
@Controller('r')
export class RedirectController {
  private readonly logger = new Logger(RedirectController.name);

  constructor(
    private readonly advertisementService: AdvertisementService,
    private readonly clickTracking: ClickTrackingService,
  ) {}

  @Get(':adId/:userId/:signature')
  async redirect(
    @Param('adId') adIdRaw: string,
    @Param('userId') userId: string,
    @Param('signature') signature: string,
    @Res() res: Response,
  ): Promise<void> {
    const adId = parseInt(adIdRaw, 10);

    if (isNaN(adId) || !/^\d{1,20}$/.test(userId)) {
      res.status(404).send('Not found');
      return;
    }

    if (!this.clickTracking.verify(adId, userId, signature)) {
      this.logger.warn(`⚠️ Неверная подпись ссылки: объявление ${adId}`);
      res.status(404).send('Not found');
      return;
    }

    const ad = await this.advertisementService.findOne(adId);

    if (!ad?.buttonUrl) {
      res.status(404).send('Not found');
      return;
    }

    // Клик засчитываем в фоне: человек не должен ждать запись в базу,
    // ради него он и нажимал кнопку
    this.advertisementService
      .recordClick(adId, BigInt(userId))
      .catch((error: Error) =>
        this.logger.warn(`⚠️ Не удалось записать клик: ${error.message}`),
      );

    // 302, а не 301: постоянный редирект браузер закеширует навсегда,
    // и следующие переходы того же человека мы просто не увидим
    res.redirect(302, ad.buttonUrl);
  }
}
