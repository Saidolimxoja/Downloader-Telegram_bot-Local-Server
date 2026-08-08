// src/modules/advertisement/click-tracking.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

/**
 * 🔗 ОТСЛЕЖИВАНИЕ ПЕРЕХОДОВ ПО РЕКЛАМЕ
 *
 * Кнопка объявления — это обычная URL-ссылка, а Telegram принципиально не
 * сообщает боту о нажатиях на такие кнопки. Поэтому счётчик кликов всегда
 * показывал ноль, а CTR — «0.00%»: продавать рекламу с такой статистикой
 * невозможно.
 *
 * Решение: кнопка ведёт не на сайт рекламодателя напрямую, а на наш адрес.
 * Мы фиксируем переход и тут же перенаправляем человека дальше. Задержка —
 * несколько миллисекунд, пользователь её не замечает.
 *
 * Ссылка подписана. Без подписи любой желающий мог бы открывать
 * /r/1/12345 в цикле и накручивать чужую статистику, а рекламодатель платит
 * именно за эти цифры.
 */
@Injectable()
export class ClickTrackingService {
  private readonly logger = new Logger(ClickTrackingService.name);
  private readonly publicUrl: string | null;
  private readonly secret: string;

  constructor(config: ConfigService) {
    const raw = config.get<string>('PUBLIC_URL')?.trim();
    // Без домена отслеживание просто отключается, а кнопки продолжают вести
    // напрямую к рекламодателю — бот остаётся работоспособным
    this.publicUrl = raw ? raw.replace(/\/+$/, '') : null;

    // Отдельный секрет не заводим: токен бота уже секретен, уже обязателен
    // и уже есть в окружении. Наружу он при этом не попадает — в ссылке
    // только усечённый хеш.
    this.secret = config.getOrThrow<string>('BOT_TOKEN');
  }

  /** Настроено ли отслеживание */
  get isEnabled(): boolean {
    return this.publicUrl !== null;
  }

  /**
   * Ссылка для кнопки объявления.
   *
   * Если домен не настроен или у объявления нет кнопки — возвращаем исходный
   * адрес рекламодателя как есть.
   */
  buildClickUrl(
    adId: number,
    userId: bigint,
    targetUrl: string | null,
  ): string | null {
    if (!targetUrl) return null;
    if (!this.publicUrl) return targetUrl;

    const signature = this.sign(adId, userId);
    return `${this.publicUrl}/r/${adId}/${userId}/${signature}`;
  }

  /** Проверка подписи при переходе */
  verify(adId: number, userId: string, signature: string): boolean {
    let expected: string;

    try {
      expected = this.sign(adId, BigInt(userId));
    } catch {
      return false;
    }

    // Сравнение постоянного времени: обычное === позволяет подобрать подпись
    // побайтово, замеряя время ответа
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);

    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  private sign(adId: number, userId: bigint): string {
    return crypto
      .createHmac('sha256', this.secret)
      .update(`${adId}:${userId}`)
      .digest('hex')
      .slice(0, 16);
  }
}
