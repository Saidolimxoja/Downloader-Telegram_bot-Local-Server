// src/modules/downloader/rate-limit.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../common/redis/redis.service';
import {
  REDIS_KEYS,
  REDIS_TTL,
} from '../../common/constants/redis-keys.constant';
import { PremiumService } from '../premium/premium.service';
import { PREMIUM_RATE_LIMIT_MULTIPLIER } from '../premium/premium.constants';

/** Результат проверки: пускаем ли запрос и что сказать пользователю, если нет */
export interface RateLimitVerdict {
  allowed: boolean;
  reason?: string;
}

/**
 * 🛡️ ОГРАНИЧЕНИЕ НАГРУЗКИ ОТ ОДНОГО ПОЛЬЗОВАТЕЛЯ
 *
 * Раньше защиты не было никакой: единственный «антиспам» снимался сразу после
 * постановки задачи в очередь, поэтому один человек мог отправить сотню ссылок
 * подряд и занять всю очередь для остальных десяти тысяч.
 *
 * Три независимых рубежа:
 *   1. минутное окно — от случайного спама пачкой ссылок;
 *   2. часовое окно  — от планомерного вычерпывания ресурсов;
 *   3. счётчик активных анализов — не даёт одному пользователю держать
 *      несколько процессов yt-dlp одновременно.
 */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);

  private readonly perMinute: number;
  private readonly perHour: number;
  private readonly maxActive: number;

  constructor(
    private readonly redis: RedisService,
    private readonly premiumService: PremiumService,
    config: ConfigService,
  ) {
    this.perMinute = config.get<number>('RATE_LIMIT_PER_MINUTE') ?? 5;
    this.perHour = config.get<number>('RATE_LIMIT_PER_HOUR') ?? 60;
    this.maxActive = config.get<number>('MAX_ACTIVE_ANALYSIS_PER_USER') ?? 2;
  }

  /**
   * Проверка перед приёмом новой ссылки. Счётчики инкрементируются здесь же:
   * отдельная «проверка» и «фиксация» дали бы гонку между процессами.
   */
  async checkAndConsume(userId: bigint): Promise<RateLimitVerdict> {
    // 💎 Премиуму лимиты подняты, а не сняты полностью: даже платящий
    // пользователь не должен иметь возможность занять всю очередь
    const isPremium = await this.premiumService.isPremium(userId);
    const multiplier = isPremium ? PREMIUM_RATE_LIMIT_MULTIPLIER : 1;

    const perMinute = this.perMinute * multiplier;
    const perHour = this.perHour * multiplier;
    const maxActive = this.maxActive * multiplier;

    const active = await this.redis.getCount(REDIS_KEYS.activeJobs(userId));

    if (active >= maxActive) {
      return {
        allowed: false,
        reason:
          '⏳ Ты уже отправил несколько ссылок — дай мне закончить с ними.\n\n' +
          'Как только они обработаются, присылай следующую.',
      };
    }

    const perMinuteKey = REDIS_KEYS.rateLimit(userId, 'min');
    const minuteCount = await this.redis.incrWithTtl(perMinuteKey, 60);

    if (minuteCount > perMinute) {
      return {
        allowed: false,
        reason:
          `🚦 Слишком много ссылок за минуту (лимит ${perMinute}).\n\n` +
          (isPremium
            ? 'Подожди немного и попробуй снова.'
            : 'Подожди немного — или оформи премиум командой /premium, там лимиты выше.'),
      };
    }

    const perHourKey = REDIS_KEYS.rateLimit(userId, 'hour');
    const hourCount = await this.redis.incrWithTtl(perHourKey, 3600);

    if (hourCount > perHour) {
      return {
        allowed: false,
        reason:
          `🚦 Достигнут часовой лимит (${perHour} видео).\n\n` +
          (isPremium
            ? 'Он сбросится в течение часа.'
            : 'Он сбросится в течение часа. С премиумом лимит в 4 раза выше — /premium'),
      };
    }

    return { allowed: true };
  }

  /** Пользователь занял слот анализа */
  async markAnalysisStarted(userId: bigint): Promise<void> {
    await this.redis.incrWithTtl(
      REDIS_KEYS.activeJobs(userId),
      REDIS_TTL.activeJobs,
    );
  }

  /**
   * Слот освободился. Вызывается воркером в finally — если процесс умрёт,
   * ключ всё равно протухнет по TTL и пользователь не останется заблокированным.
   */
  async markAnalysisFinished(userId: bigint): Promise<void> {
    await this.redis.decr(REDIS_KEYS.activeJobs(userId));
  }
}
