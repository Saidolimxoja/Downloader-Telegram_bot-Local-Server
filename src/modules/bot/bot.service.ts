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
  public bot: Bot<Context>;
  private readonly logger = new Logger(BotService.name);
  private isShuttingDown = false;

  constructor(
    private config: ConfigService,
    private uploaderService: UploaderService,
  ) {
    const token = this.config.get<string>('BOT_TOKEN')!;

    // 1️⃣ СНАЧАЛА создаем бота
    this.bot = new Bot(token, {
      client: {
        apiRoot: 'http://localhost:8081',
      },
    });

    this.logger.log('✅ Бот переведен на LOCAL API (Docker)');

    // 2️⃣ ПОТОМ устанавливаем в UploaderService
    this.uploaderService.setBot(this.bot);
    this.logger.log('✅ Bot instance установлен в UploaderService');
  }

  async onModuleInit() {
    try {
      this.logger.log('🚀 BotService: onModuleInit начат');

      const me = await this.bot.api.getMe();
      this.logger.log(`✅ Бот авторизован: @${me.username} (ID: ${me.id})`);

      // Устанавливаем команды
      await this.bot.api.setMyCommands([
        { command: 'start', description: 'Запуск бота' },
        { command: 'help', description: 'Помощь' },
        { command: 'stats', description: 'Статистика' },
        { command: 'channelid', description: 'Получить ID чата' },
        { command: 'checkchannels', description: 'Проверка каналов (админ)' },
        { command: 'admin', description: 'Админ-панель (админ)' },
      ]);
      this.logger.log('✅ Команды установлены');

      // Проверяем webhook или polling
      const webhookUrl = this.config.get<string>('WEBHOOK_URL');

      if (webhookUrl) {
        // Webhook mode (для продакшена)
        await this.bot.api.setWebhook(webhookUrl, {
          drop_pending_updates: true,
        });
        this.logger.log(`✅ Webhook установлен: ${webhookUrl}`);
      } else {
        // Polling mode (для разработки)
        this.logger.log('🚀 Запуск бота...');

        await this.bot.start({
          drop_pending_updates: true,
          onStart: (botInfo) => {
            this.logger.log(`\n ========================================`);
            this.logger.log(`   BOT STARTED: @${botInfo.username}`);
            this.logger.log(`========================================\n`);
          },
        });
      }
    } catch (error: any) {
      if (error.error_code === 409) {
        this.logger.error('❌ Бот уже запущен в другом процессе!');
        this.logger.error('💡 Используй: pkill -9 -f "node.*nest"');
        process.exit(1);
      }
      throw error;
    }
  }

  async onModuleDestroy() {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    this.logger.warn('🛑 Остановка бота...');

    try {
      await this.bot.stop();
      this.logger.log('✅ Бот успешно остановлен');
    } catch (error: any) {
      if (error.error_code !== 409) {
        this.logger.error(`❌ Ошибка при остановке: ${error.message}`);
      }
    }
  }

  getBot(): Bot<Context> {
    return this.bot;
  }
}
