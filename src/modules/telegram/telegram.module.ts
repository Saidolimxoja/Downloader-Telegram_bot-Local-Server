// src/modules/telegram/telegram.module.ts

import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, Context } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';

/** DI-токен единственного экземпляра бота */
export const TELEGRAM_BOT = 'TELEGRAM_BOT';

/**
 * 🤖 ЕДИНСТВЕННЫЙ ЭКЗЕМПЛЯР БОТА НА ПРОЦЕСС
 *
 * До этого в приложении жили ДВА разных объекта Bot с одним токеном:
 *   • BotService создавал свой — с apiRoot локального Bot API server;
 *   • NestjsGrammyModule создавал ещё один — БЕЗ apiRoot.
 *
 * Всё, что ходило через второй (прогресс-сообщения и аварийная отправка файла
 * напрямую в downloader.service), било в api.telegram.org мимо локального
 * сервера — то есть упиралось в лимит 50 МБ, ради обхода которого локальный
 * сервер и поднимался. Теперь экземпляр один и он всегда знает про apiRoot.
 */
const botProvider = {
  provide: TELEGRAM_BOT,
  useFactory: (config: ConfigService): Bot<Context> => {
    const token = config.getOrThrow<string>('BOT_TOKEN');
    const apiRoot = config.getOrThrow<string>('API_URL');

    const bot = new Bot<Context>(token, {
      client: {
        apiRoot,
        // Заливка двухгигабайтного файла в локальный сервер идёт долго;
        // дефолтные 500 секунд оставляем, но фиксируем явно
        timeoutSeconds: 500,
      },
    });

    // 🛡️ Автоматическая обработка 429 Too Many Requests: плагин сам ждёт
    // retry_after и повторяет запрос. Без него на пиковой нагрузке часть
    // сообщений просто терялась бы с ошибкой флуд-контроля.
    bot.api.config.use(
      autoRetry({
        maxRetryAttempts: 3,
        maxDelaySeconds: 60,
      }),
    );

    return bot;
  },
  inject: [ConfigService],
};

/**
 * Глобальный и без зависимостей от других модулей — поэтому его может
 * импортировать кто угодно, не создавая циклов (раньше ради этого
 * приходилось городить forwardRef между Bot / Downloader / Uploader).
 */
@Global()
@Module({
  providers: [botProvider],
  exports: [botProvider],
})
export class TelegramModule {}
