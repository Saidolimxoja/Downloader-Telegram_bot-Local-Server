// src/common/redis/redis.service.ts

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * 🗄️ ЕДИНОЕ ХРАНИЛИЩЕ КОРОТКОЖИВУЩЕГО СОСТОЯНИЯ
 *
 * Раньше антиспам, кеш подписки, счётчик рекламы и кулдаун подсказок жили в
 * обычных Map внутри процесса. Это ломалось дважды: Map росли без выселения
 * (утечка памяти), и при запуске второго процесса состояние расходилось —
 * реклама показывалась дважды, антиспам не срабатывал.
 *
 * Redis решает оба: TTL чистит записи сам, а состояние общее для бота и всех
 * воркеров. Redis уже есть в стеке ради BullMQ, отдельная инфраструктура не нужна.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;

  constructor(config: ConfigService) {
    this.client = new Redis({
      host: config.get<string>('REDIS_HOST') || '127.0.0.1',
      port: config.get<number>('REDIS_PORT') || 6379,
      // Команды, отправленные до установки соединения, копятся в очереди
      // вместо того, чтобы падать — важно на старте процесса
      enableOfflineQueue: true,
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 200, 5000),
    });

    this.client.on('error', (err) => {
      // Логируем, но не роняем процесс: Redis может моргнуть, а бот должен жить
      this.logger.error(`❌ Redis: ${err.message}`);
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.client.ping();
      this.logger.log('✅ Redis подключён');
    } catch (error: any) {
      this.logger.error(`❌ Redis недоступен: ${error.message}`);
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }

  /** Прямой доступ к клиенту — для нестандартных операций */
  get raw(): Redis {
    return this.client;
  }

  // ==================== БАЗОВЫЕ ОПЕРАЦИИ ====================

  async get(key: string): Promise<string | null> {
    try {
      return await this.client.get(key);
    } catch (error: any) {
      this.logger.warn(`⚠️ GET ${key}: ${error.message}`);
      return null;
    }
  }

  async setEx(key: string, value: string, ttlSeconds: number): Promise<void> {
    try {
      await this.client.set(key, value, 'EX', ttlSeconds);
    } catch (error: any) {
      this.logger.warn(`⚠️ SET ${key}: ${error.message}`);
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      await this.client.del(...keys);
    } catch (error: any) {
      this.logger.warn(`⚠️ DEL ${keys[0]}: ${error.message}`);
    }
  }

  /**
   * 🔢 Счётчик с TTL: инкремент плюс срок жизни, выставляемый ОДИН раз.
   *
   * Флаг NX здесь принципиален. Если продлевать TTL на каждом инкременте,
   * окно перестаёт быть окном: пользователь, пишущий раз в полминуты, вечно
   * держит минутный счётчик живым и рано или поздно упирается в лимит,
   * из которого уже не выйдет. С NX окно честно закрывается через ttlSeconds
   * после первого запроса.
   *
   * Возвращает 0 при сбое Redis — лимиты не должны блокировать людей из-за
   * проблем с хранилищем.
   */
  async incrWithTtl(key: string, ttlSeconds: number): Promise<number> {
    try {
      const result = await this.client
        .multi()
        .incr(key)
        .expire(key, ttlSeconds, 'NX')
        .exec();

      const value = result?.[0]?.[1];
      return typeof value === 'number' ? value : 0;
    } catch (error: any) {
      this.logger.warn(`⚠️ INCR ${key}: ${error.message}`);
      return 0;
    }
  }

  async decr(key: string): Promise<void> {
    try {
      // Не даём счётчику уйти в минус, если DECR прилетел без парного INCR
      const value = await this.client.decr(key);
      if (value < 0) await this.client.set(key, '0');
    } catch (error: any) {
      this.logger.warn(`⚠️ DECR ${key}: ${error.message}`);
    }
  }

  async getCount(key: string): Promise<number> {
    const raw = await this.get(key);
    const value = raw ? parseInt(raw, 10) : 0;
    return isNaN(value) ? 0 : value;
  }

  /**
   * 🔒 Захват блокировки. true — блокировка наша, false — держит кто-то другой.
   * TTL обязателен: если процесс умрёт, блокировка не останется навечно.
   */
  async acquireLock(key: string, ttlSeconds: number): Promise<boolean> {
    try {
      const result = await this.client.set(key, '1', 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    } catch (error: any) {
      this.logger.warn(`⚠️ LOCK ${key}: ${error.message}`);
      // При недоступности Redis пропускаем — лучше выполнить работу дважды,
      // чем не выполнить вообще
      return true;
    }
  }

  async releaseLock(key: string): Promise<void> {
    await this.del(key);
  }

  // ==================== JSON ====================

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.get(key);
    if (!raw) return null;

    try {
      return JSON.parse(raw) as T;
    } catch {
      this.logger.warn(`⚠️ Битый JSON в ключе ${key}, удаляю`);
      await this.del(key);
      return null;
    }
  }

  async setJson(
    key: string,
    value: unknown,
    ttlSeconds: number,
  ): Promise<void> {
    await this.setEx(key, JSON.stringify(value), ttlSeconds);
  }

  // ==================== МАССОВЫЕ ОПЕРАЦИИ ====================

  /**
   * 🧹 Удаление ключей по маске через SCAN (не KEYS — тот блокирует Redis
   * целиком). Используется редко: при смене списка обязательных каналов.
   */
  async deleteByPattern(pattern: string): Promise<number> {
    let deleted = 0;
    let cursor = '0';

    try {
      do {
        const [next, keys] = await this.client.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          500,
        );
        cursor = next;

        if (keys.length > 0) {
          await this.client.del(...keys);
          deleted += keys.length;
        }
      } while (cursor !== '0');
    } catch (error: any) {
      this.logger.warn(`⚠️ SCAN ${pattern}: ${error.message}`);
    }

    return deleted;
  }

  /** Проверка живости для /health */
  async isHealthy(): Promise<boolean> {
    try {
      const pong = await this.client.ping();
      return pong === 'PONG';
    } catch {
      return false;
    }
  }
}
