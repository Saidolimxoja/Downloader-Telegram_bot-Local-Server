// src/modules/health/health.controller.ts

import { Controller, Get } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import {
  ANALYZE_QUEUE,
  DOWNLOAD_QUEUE,
} from '../downloader/interfaces/download-job.interface';
import { getRole } from '../../config/role';

/**
 * 🩺 НАБЛЮДАЕМОСТЬ
 *
 * HTTP-порт приложение слушало и раньше, но не отдавало ничего: ни одного
 * контроллера в проекте не было. При десяти тысячах пользователей это работа
 * вслепую — непонятно, жив ли Redis, растёт ли очередь, не кончился ли диск.
 *
 * GET /health  — короткий ответ для мониторинга и docker healthcheck
 * GET /metrics — числа для дашборда или Prometheus-экспортера
 */
@Controller()
export class HealthController {
  constructor(
    @InjectQueue(ANALYZE_QUEUE) private readonly analyzeQueue: Queue,
    @InjectQueue(DOWNLOAD_QUEUE) private readonly downloadQueue: Queue,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get('health')
  async health() {
    const [database, redis] = await Promise.all([
      this.checkDatabase(),
      this.redis.isHealthy(),
    ]);

    const healthy = database && redis;

    return {
      status: healthy ? 'ok' : 'degraded',
      role: getRole(),
      uptimeSeconds: Math.round(process.uptime()),
      checks: { database, redis },
    };
  }

  @Get('metrics')
  async metrics() {
    const [analyze, download] = await Promise.all([
      this.queueCounts(this.analyzeQueue),
      this.queueCounts(this.downloadQueue),
    ]);

    const memory = process.memoryUsage();

    return {
      role: getRole(),
      uptimeSeconds: Math.round(process.uptime()),
      queues: { analyze, download },
      memoryMb: {
        rss: Math.round(memory.rss / 1024 / 1024),
        heapUsed: Math.round(memory.heapUsed / 1024 / 1024),
      },
    };
  }

  private async checkDatabase(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  private async queueCounts(queue: Queue) {
    try {
      const counts = await queue.getJobCounts(
        'waiting',
        'active',
        'failed',
        'delayed',
      );

      return {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        failed: counts.failed ?? 0,
        delayed: counts.delayed ?? 0,
      };
    } catch {
      return { waiting: -1, active: -1, failed: -1, delayed: -1 };
    }
  }
}
