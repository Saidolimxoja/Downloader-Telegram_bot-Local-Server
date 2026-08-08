// src/modules/channel/channel.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { RequiredChannel } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { REDIS_KEYS } from '../../common/constants/redis-keys.constant';

@Injectable()
export class ChannelService {
  private readonly logger = new Logger(ChannelService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
  ) {}

  /**
   * Активные обязательные каналы.
   *
   * Список меняется раз в месяц, а читается на каждое сообщение — держим его
   * в памяти процесса на минуту. При изменении списка кеш сбрасывается явно.
   */
  async getActiveChannels(): Promise<RequiredChannel[]> {
    const now = Date.now();

    if (this.activeChannelsCache && now < this.activeChannelsExpireAt) {
      return this.activeChannelsCache;
    }

    const channels = await this.prisma.requiredChannel.findMany({
      where: { isActive: true },
      orderBy: { priority: 'asc' },
    });

    this.activeChannelsCache = channels;
    this.activeChannelsExpireAt = now + ChannelService.CHANNELS_CACHE_MS;

    return channels;
  }

  async create(data: {
    channelId: string;
    channelName: string;
    channelLink: string;
    priority?: number;
  }): Promise<RequiredChannel> {
    const channel = await this.prisma.requiredChannel.create({
      data: {
        channelId: data.channelId,
        channelName: data.channelName,
        channelLink: data.channelLink,
        priority: data.priority ?? 0,
      },
    });

    await this.invalidate();
    return channel;
  }

  async delete(id: number): Promise<void> {
    await this.prisma.requiredChannel.delete({ where: { id } });
    await this.invalidate();
  }

  async toggle(id: number): Promise<RequiredChannel> {
    const channel = await this.prisma.requiredChannel.findUnique({
      where: { id },
    });

    if (!channel) {
      throw new Error('Channel not found');
    }

    const updated = await this.prisma.requiredChannel.update({
      where: { id },
      data: { isActive: !channel.isActive },
    });

    await this.invalidate();
    return updated;
  }

  async getAll(): Promise<RequiredChannel[]> {
    return this.prisma.requiredChannel.findMany({
      orderBy: { priority: 'asc' },
    });
  }

  // ==================== КЕШ ====================

  private activeChannelsCache: RequiredChannel[] | null = null;
  private activeChannelsExpireAt = 0;
  private static readonly CHANNELS_CACHE_MS = 60_000;

  /**
   * Список каналов изменился — обнуляем и локальный кеш, и все сохранённые
   * результаты проверки подписки. Без этого админ добавляет канал, а часть
   * пользователей ещё пять минут проходит по старой проверке.
   */
  private async invalidate(): Promise<void> {
    this.activeChannelsCache = null;
    this.activeChannelsExpireAt = 0;

    const deleted = await this.redis.deleteByPattern(
      REDIS_KEYS.subscriptionPattern,
    );
    this.logger.log(
      `🔄 Список каналов изменён, сброшено проверок подписки: ${deleted}`,
    );
  }
}
