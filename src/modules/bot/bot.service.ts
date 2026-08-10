// src/modules/bot/bot.service.ts

import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Bot, Context } from 'grammy';
import type { BotCommand, BotCommandScope } from 'grammy/types';
import { TELEGRAM_BOT } from '../telegram/telegram.module';
import { getRole, isBotRole } from '../../config/role';

/**
 * Публичное меню команд.
 *
 * Служебных команд (/admin, /checkchannels, /refund) здесь нет намеренно.
 * Скрыть их персонально нельзя без учёта состояния: scope: { type: 'chat' }
 * живёт на серверах Telegram, пока его явно не удалят, а права админа
 * меняются напрямую в базе — приложение об этом не узнаёт и не смогло бы
 * снять меню у разжалованного.
 *
 * Поэтому меню одно для всех, а доступ решает не оно: каждый админский
 * хендлер и так проверяет isAdmin по базе на каждом вызове (bot.update.ts).
 * Админы вводят команду руками — она работает.
 */
const PUBLIC_COMMANDS: BotCommand[] = [
  { command: 'start', description: 'Запуск бота' },
  { command: 'premium', description: '💎 Премиум — без рекламы и лимитов' },
  { command: 'ref', description: '🎁 Пригласить друзей' },
  { command: 'help', description: 'Помощь' },
  { command: 'channelid', description: 'Получить ID чата' },
];

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BotService.name);
  private isShuttingDown = false;

  constructor(@Inject(TELEGRAM_BOT) private readonly bot: Bot<Context>) {}

  async onModuleInit() {
    this.logger.log(`🚀 Инициализация бота (роль: ${getRole()})...`);

    // Воркер апдейты не принимает: ни getMe, ни меню команд ему не нужны.
    // Раньше каждая реплика дёргала оба запроса на старте, а недоступность
    // Telegram API валила процесс, которому она в тот момент была не нужна.
    if (!isBotRole()) {
      this.logger.log(
        '⚙️ Роль worker: обращения к Telegram API при старте пропущены',
      );
      return;
    }

    try {
      const me = await this.bot.api.getMe();
      this.logger.log(`✅ Бот: @${me.username} (ID: ${me.id})`);

      await this.registerCommands();
    } catch (error: any) {
      this.handleError(error);
    }
  }

  /**
   * Меню команд.
   *
   * Telegram хранит не один список, а дерево scope'ов с приоритетом
   * chat → chat_member → all_private_chats → default, и внутри каждого — ещё
   * разбивку по language_code. Клиент показывает самый специфичный непустой
   * список. Поэтому просто записать новый набор в default мало: старый список
   * в all_private_chats или в языковой версии продолжит его перекрывать —
   * ровно из-за этого правки через BotFather «не применялись».
   *
   * Отсюда порядок: сначала снести все варианты, где мог осесть старый набор,
   * и только потом записать актуальный.
   */
  private async registerCommands() {
    const scopes: BotCommandScope[] = [
      { type: 'default' },
      { type: 'all_private_chats' },
    ];

    // Пустой language_code — базовый список, 'ru' и 'en' задавались раньше кодом
    for (const scope of scopes) {
      for (const language_code of [undefined, 'ru', 'en'] as const) {
        await this.bot.api.deleteMyCommands({ scope, language_code });
      }
    }

    for (const scope of scopes) {
      await this.bot.api.setMyCommands(PUBLIC_COMMANDS, { scope });
    }

    this.logger.log(`✅ Команды установлены (${PUBLIC_COMMANDS.length} шт.)`);
  }

  private handleError(error: any) {
    if (error?.description?.includes('Conflict')) {
      this.logger.error('❌ Бот уже запущен в другом процессе!');
      this.logger.error('💡 Останови другой процесс (Docker или локальный)');
      process.exit(1);
    }

    this.logger.error(`❌ Ошибка: ${error.message}`);
    throw error;
  }

  async onModuleDestroy() {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    // Останавливать polling имеет смысл только там, где он запущен.
    // На воркере bot.stop() просто ждал бы несуществующий цикл получения апдейтов.
    if (!isBotRole()) return;

    this.logger.warn('🛑 Остановка бота...');

    try {
      await this.bot.stop();
      this.logger.log('✅ Бот остановлен');
    } catch {
      // игнорируем ошибки остановки
    }
  }

  getBot(): Bot<Context> {
    return this.bot;
  }
}
