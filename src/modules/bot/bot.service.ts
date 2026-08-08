// src/modules/bot/bot.service.ts

import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Bot, Context } from 'grammy';
import { TELEGRAM_BOT } from '../telegram/telegram.module';
import { getRole, isBotRole } from '../../config/role';

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

      await this.bot.api.setMyCommands([
        { command: 'start', description: 'Запуск бота' },
        {
          command: 'premium',
          description: '💎 Премиум — без рекламы и лимитов',
        },
        { command: 'ref', description: '🎁 Пригласить друзей' },
        { command: 'help', description: 'Помощь' },
        { command: 'channelid', description: 'Получить ID чата' },
        { command: 'checkchannels', description: 'Проверка каналов (админ)' },
        { command: 'admin', description: 'Админ-панель (админ)' },
      ]);

      this.logger.log('✅ Команды установлены');
    } catch (error: any) {
      this.handleError(error);
    }
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
