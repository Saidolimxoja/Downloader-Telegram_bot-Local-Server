import { Injectable } from '@nestjs/common';
import { Bot, Context, InlineKeyboard } from 'grammy';
import { ChannelService } from '../channel/channel.service';

@Injectable()
export class SubscriptionService {
  private subscriptionCache = new Map<number, { result: boolean; timestamp: number }>();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 минут

  constructor(private channelService: ChannelService) {}

  /**
   * Проверить подписан ли пользователь на все каналы (с кешем)
   */
  async checkAll(userId: number, bot: Bot<Context>): Promise<boolean> {
    const cached = this.subscriptionCache.get(userId);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      console.log(`✅ Пользователь ${userId} подписан на все каналы (из кеша)`);
      return cached.result;
    }

    const channels = await this.channelService.getActiveChannels();

    if (channels.length === 0) {
      return true;
    }

    const results = await Promise.allSettled(
      channels.map(async (channel) => {
        try {
          const member = await bot.api.getChatMember(channel.channelId, userId);
          const validStatuses = ['member', 'administrator', 'creator'];
          return validStatuses.includes(member.status);
        } catch (error) {
          console.error(`❌ Ошибка проверки канала ${channel.channelId}:`, error);
          return false;
        }
      }),
    );

    const allSubscribed = results.every(
      (result) => result.status === 'fulfilled' && result.value === true,
    );

    this.subscriptionCache.set(userId, {
      result: allSubscribed,
      timestamp: Date.now(),
    });

    if (!allSubscribed) {
      console.log(`❌ Пользователь ${userId} не подписан на все каналы`);
    } else {
      console.log(`✅ Пользователь ${userId} подписан на все каналы`);
    }

    return allSubscribed;
  }

  /**
   * Получить клавиатуру с кнопками подписки
   */
  async getSubscriptionKeyboard(): Promise<InlineKeyboard> {
    const channels = await this.channelService.getActiveChannels();
    const keyboard = new InlineKeyboard();

    for (const channel of channels) {
      const buttonText = `📢 ${channel.channelName}`;
      const url =
        channel.channelLink ||
        `https://t.me/${channel.channelId.replace('@', '')}`;
      keyboard.url(buttonText, url).row();
    }

    // Кнопка проверки
    keyboard.text('✅ Проверить подписку', 'check_subscription');

    return keyboard;
  }
}
