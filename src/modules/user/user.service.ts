// src/modules/user/user.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { User } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Создать или обновить пользователя.
   *
   * Было два запроса подряд — findUnique, затем update или create. Postgres
   * умеет это одной командой (INSERT ... ON CONFLICT DO UPDATE), что вдвое
   * дешевле и не имеет гонки между проверкой и записью.
   */
  async createOrUpdate(dto: CreateUserDto): Promise<User> {
    return this.prisma.user.upsert({
      where: { id: dto.id },
      update: {
        username: dto.username,
        firstName: dto.firstName,
        lastName: dto.lastName,
        lastActiveAt: new Date(),
      },
      create: {
        id: dto.id,
        username: dto.username,
        firstName: dto.firstName,
        lastName: dto.lastName,
      },
    });
  }

  /**
   * 🔑 ОДИН ЗАПРОС НА ГОРЯЧЕМ ПУТИ
   *
   * На каждое сообщение со ссылкой раньше уходили: SELECT * для проверки бана
   * (и ещё один SELECT * при проверке админа). Здесь всё сразу: пользователь
   * гарантированно заведён (иначе история загрузок падала бы по внешнему ключу),
   * lastActiveAt обновлён, флаги получены — одной командой.
   */
  async ensureUser(
    dto: CreateUserDto,
  ): Promise<{ isBanned: boolean; isAdmin: boolean }> {
    try {
      const user = await this.prisma.user.upsert({
        where: { id: dto.id },
        update: {
          username: dto.username,
          firstName: dto.firstName,
          lastName: dto.lastName,
          lastActiveAt: new Date(),
        },
        create: {
          id: dto.id,
          username: dto.username,
          firstName: dto.firstName,
          lastName: dto.lastName,
        },
        select: { isBanned: true, isAdmin: true },
      });

      return user;
    } catch (error: any) {
      this.logger.error(`❌ ensureUser(${dto.id}): ${error.message}`);
      // «Не админ и не забанен» — самый безопасный ответ при сбое БД:
      // прав не выдаём, но и живого пользователя не блокируем
      return { isBanned: false, isAdmin: false };
    }
  }

  async findById(id: bigint): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  /**
   * Существует ли пользователь.
   *
   * Нужно реферальной программе: награда начисляется только за НОВОГО
   * человека, иначе достаточно было бы повторно открыть чужую ссылку,
   * чтобы бесконечно начислять дни премиума.
   */
  async exists(id: bigint): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true },
    });

    return user !== null;
  }

  /** Проверка бана — тянем один булев столбец вместо всей строки */
  async isBanned(userId: bigint): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isBanned: true },
    });

    return user?.isBanned ?? false;
  }

  /** Проверка прав администратора */
  async isAdmin(userId: bigint): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isAdmin: true },
    });

    return user?.isAdmin ?? false;
  }

  /**
   * ID всех администраторов.
   *
   * Нужен на старте бота, чтобы разослать им расширенное меню команд через
   * scope: { type: 'chat' }. Админов единицы, поэтому берём разом и без кеша —
   * запрос выполняется один раз за жизнь процесса.
   */
  async findAdminIds(): Promise<bigint[]> {
    const admins = await this.prisma.user.findMany({
      where: { isAdmin: true },
      select: { id: true },
    });

    return admins.map((admin) => admin.id);
  }

  /**
   * Увеличить счётчик загрузок.
   *
   * Пользователь мог не существовать (прислал ссылку в группе, ни разу не
   * открыв бота) — тогда update кидает P2025. Это статистика, ронять из-за
   * неё выдачу готового файла нельзя.
   */
  async incrementDownloads(userId: bigint): Promise<void> {
    if (userId <= 0n) return;

    try {
      await this.prisma.user.update({
        where: { id: userId },
        data: { totalDownloads: { increment: 1 } },
      });
    } catch (error: any) {
      this.logger.warn(`⚠️ Счётчик загрузок ${userId}: ${error.message}`);
    }
  }

  async getStats() {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Один поход в БД вместо двух последовательных
    const [totalUsers, activeToday] = await this.prisma.$transaction([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { lastActiveAt: { gte: dayAgo } } }),
    ]);

    return { totalUsers, activeToday };
  }
}
