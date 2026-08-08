// src/modules/subscription/subscription.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { Bot, Context, InlineKeyboard } from 'grammy';
import { ChannelService } from '../channel/channel.service';
import { RedisService } from '../../common/redis/redis.service';
import {
  REDIS_KEYS,
  REDIS_TTL,
} from '../../common/constants/redis-keys.constant';

@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);

  constructor(
    private channelService: ChannelService,
    private redis: RedisService,
  ) {}

  /**
   * Проверить, подписан ли пользователь на все обязательные каналы.
   *
   * Результат кешируется в Redis на 5 минут. Раньше кеш был обычной Map: она
   * росла без выселения (запись на каждого из десяти тысяч пользователей
   * оставалась навсегда) и не была видна другим процессам. TTL в Redis решает
   * и то, и другое.
   */
  async checkAll(userId: number, bot: Bot<Context>): Promise<boolean> {
    const cacheKey = REDIS_KEYS.subscription(userId);

    const cached = await this.redis.get(cacheKey);
    if (cached !== null) return cached === '1';

    const channels = await this.channelService.getActiveChannels();

    // Обязательных каналов нет — пускаем всех, но результат тоже кешируем,
    // чтобы не ходить в БД на каждое сообщение
    if (channels.length === 0) {
      await this.redis.setEx(cacheKey, '1', REDIS_TTL.subscription);
      return true;
    }

    const results = await Promise.all(
      channels.map(async (channel) => {
        try {
          const member = await bot.api.getChatMember(channel.channelId, userId);
          return ['member', 'administrator', 'creator'].includes(member.status);
        } catch (error: any) {
          this.logger.warn(
            `⚠️ Проверка канала ${channel.channelId}: ${error.message}`,
          );
          // Не смогли проверить — считаем «не подписан», иначе обязательная
          // подписка обходилась бы простым падением API
          return false;
        }
      }),
    );

    const allSubscribed = results.every(Boolean);

    await this.redis.setEx(
      cacheKey,
      allSubscribed ? '1' : '0',
      REDIS_TTL.subscription,
    );

    return allSubscribed;
  }

  /**
   * 🔄 Сбросить кеш проверок.
   *
   * Нужно вызывать при любом изменении списка обязательных каналов: иначе
   * до пяти минут часть пользователей продолжала бы ходить мимо новой проверки.
   */
  async invalidateAll(): Promise<void> {
    const deleted = await this.redis.deleteByPattern(
      REDIS_KEYS.subscriptionPattern,
    );
    this.logger.log(`🔄 Сброшен кеш подписок: ${deleted} записей`);
  }

  /** Сбросить кеш конкретного пользователя (после кнопки «Проверить подписку») */
  async invalidateUser(userId: number): Promise<void> {
    await this.redis.del(REDIS_KEYS.subscription(userId));
  }

  async getSubscriptionKeyboard(): Promise<InlineKeyboard> {
    const channels = await this.channelService.getActiveChannels();
    const keyboard = new InlineKeyboard();

    for (const channel of channels) {
      const url =
        channel.channelLink ||
        `https://t.me/${channel.channelId.replace('@', '')}`;
      keyboard.url(`📢 ${channel.channelName}`, url).row();
    }

    keyboard.text('✅ Проверить подписку', 'check_subscription');
    return keyboard;
  }
}
