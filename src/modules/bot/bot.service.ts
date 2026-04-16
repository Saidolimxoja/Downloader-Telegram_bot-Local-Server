import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, Context } from 'grammy';
import { UploaderService } from '../uploader/uploader.service';

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BotService.name);
  private readonly bot: Bot<Context>;
  private isShuttingDown = false;

  constructor(
    private readonly config: ConfigService,
    private readonly uploaderService: UploaderService,
  ) {
    const token = this.config.getOrThrow<string>('BOT_TOKEN');
    const apiUrl = this.config.getOrThrow<string>('API_URL');

    this.bot = new Bot(token, {
      client: {
        apiRoot: apiUrl,
      },
    });

    this.logger.log(`🌐 Telegram API: ${apiUrl}`);
  }

  async onModuleInit() {
    try {
      this.logger.log('🚀 Инициализация бота...');

      // 👉 Передаём bot в сервисы ТОЛЬКО после полной инициализации
      this.uploaderService.setBot(this.bot);

      // 👉 Проверка бота
      const me = await this.bot.api.getMe();
      this.logger.log(`✅ Бот: @${me.username} (ID: ${me.id})`);

      // 👉 Команды
      await this.bot.api.setMyCommands([
        { command: 'start', description: 'Запуск бота' },
        { command: 'help', description: 'Помощь' },
        { command: 'stats', description: 'Статистика' },
        { command: 'channelid', description: 'Получить ID чата' },
        { command: 'checkchannels', description: 'Проверка каналов (админ)' },
        { command: 'admin', description: 'Админ-панель (админ)' },
      ]);

      this.logger.log('✅ Команды установлены');

      // 👉 Webhook или polling
      const webhookUrl = this.config.get<string>('WEBHOOK_URL');

      if (webhookUrl) {
        await this.bot.api.setWebhook(webhookUrl, {
          drop_pending_updates: true,
        });

        this.logger.log(`🌐 Webhook: ${webhookUrl}`);
      } else {
        await this.startPolling();
      }
    } catch (error: any) {
      this.handleError(error);
    }
  }

  // 🔥 Отдельный метод запуска
  private async startPolling() {
    try {
      this.logger.log('🚀 Запуск polling...');

      await this.bot.start({
        drop_pending_updates: true,
        onStart: (botInfo) => {
          this.logger.log(`🤖 BOT STARTED: @${botInfo.username}`);
        },
      });
    } catch (error: any) {
      this.handleError(error);
    }
  }

  // 🔥 Централизованная обработка ошибок
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