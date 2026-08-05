// src/modules/bot/bot.update.ts

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { run, sequentialize, RunnerHandle } from '@grammyjs/runner';
import { Context } from 'grammy';
import { BotService } from './bot.service';
import { UserService } from '../user/user.service';
import { SubscriptionService } from '../subscription/subscription.service';
import { MESSAGES } from '../../common/constants/messages.constant';
import { DownloaderService } from '../downloader/downloader.service';
import { AdminScene } from '../admin/admin.scene';
import { PrismaService } from 'src/database/prisma.service';

/** 🌐 Домены, с которых бот умеет скачивать видео. */
const SUPPORTED_DOMAINS = ['youtube.com', 'youtu.be', 'instagram.com'];

/** ⏱ Как часто (мс) можно повторять подсказку одному пользователю. */
const HINT_COOLDOWN_MS = 30_000;

@Injectable()
export class BotUpdate implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BotUpdate.name);
  private runHandle: RunnerHandle | null = null;

  /**
   * 🔇 Антиспам подсказок: userId → время последней отправленной подсказки (мс).
   * Безопасно как обычный Map: sequentialize() гарантирует, что сообщения
   * одного чата обрабатываются последовательно, без гонок.
   */
  private readonly lastHintAt = new Map<number, number>();
  constructor(
    private prisma: PrismaService,
    private botService: BotService,
    private userService: UserService,
    private subscriptionService: SubscriptionService,
    private downloaderService: DownloaderService,
    private adminScene: AdminScene,
  ) {
    this.logger.log('🔧 BotUpdate: constructor вызван');
  }

  async onModuleInit() {
    this.logger.log('🔄 BotUpdate: onModuleInit ВЫЗВАН');
    this.registerHandlers();
    await this.startBot();
  }

  private registerHandlers() {
    const bot = this.botService.getBot();
    this.logger.log('📝 Регистрация обработчиков...');

    // 🔀 Параллельная обработка апдейтов (runner) требует упорядочивания
    // сообщений в рамках одного чата, чтобы не было гонок состояний (админ-сцены,
    // антиспам и т.д.). Разные чаты обрабатываются параллельно.
    bot.use(
      sequentialize((ctx) => {
        const id = ctx.chat?.id ?? ctx.from?.id;
        return id === undefined ? undefined : id.toString();
      }),
    );

    // ==================== ADMIN COMMANDS ====================

    bot.command('admin', async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      try {
        const isAdmin = await this.userService.isAdmin(BigInt(userId));
        if (!isAdmin) {
          await ctx.reply(MESSAGES.ERROR_NO_ACCESS);
          return;
        }

        await this.adminScene.showMainMenu(ctx);
      } catch (error) {
        this.logger.error('❌ Ошибка в /admin:', error);
      }
    });

    bot.command('checkchannels', async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      try {
        const isAdmin = await this.userService.isAdmin(BigInt(userId));
        if (!isAdmin) {
          await ctx.reply(MESSAGES.ERROR_NO_ACCESS);
          return;
        }

        const channels =
          await this.subscriptionService['channelService'].getActiveChannels();

        if (channels.length === 0) {
          await ctx.reply('📭 Нет активных каналов');
          return;
        }

        let message = '📢 *Проверка каналов:*\n\n';

        for (const channel of channels) {
          try {
            const chat = await bot.api.getChat(channel.channelId);
            message += `✅ ${channel.channelName}\n`;
            message += `   ID: \`${channel.channelId}\`\n`;
            message += `   Название: ${chat.title}\n`;
            message += `   Тип: ${chat.type}\n\n`;
          } catch (error: any) {
            message += `❌ ${channel.channelName}\n`;
            message += `   ID: \`${channel.channelId}\`\n`;
            message += `   Ошибка: ${error.message}\n\n`;
          }
        }

        await ctx.reply(message, { parse_mode: 'Markdown' });
      } catch (error) {
        this.logger.error('❌ Ошибка в /checkchannels:', error);
        await ctx.reply('❌ Ошибка проверки');
      }
    });

    // ==================== ADMIN MENU NAVIGATION ====================

    bot.callbackQuery('admin:main', async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.adminScene.showMainMenu(ctx);
    });

    bot.callbackQuery('admin:ads', async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.adminScene.showAdsMenu(ctx);
    });

    bot.callbackQuery('admin:channels', async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.adminScene.showChannelsMenu(ctx);
    });

    bot.callbackQuery('admin:stats', async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.adminScene.showStats(ctx);
    });

    // ==================== CREATE AD FLOW ====================

    // Начать создание объявления
    bot.callbackQuery('admin:ad:create', async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.adminScene.startCreateAd(ctx);
    });

    // Пропустить медиа
    bot.callbackQuery('admin:ad:skip_media', async (ctx) => {
      await this.adminScene.skipMedia(ctx);
    });

    // Добавить кнопку
    bot.callbackQuery('admin:ad:add_button', async (ctx) => {
      await this.adminScene.addButton(ctx);
    });

    // Пропустить кнопку
    bot.callbackQuery('admin:ad:skip_button', async (ctx) => {
      await this.adminScene.skipButton(ctx);
    });

    // ==================== MANAGE ADS ====================

    // Списки для действий
    bot.callbackQuery(/^admin:ad:list:(edit|delete|toggle)$/, async (ctx) => {
      const action = ctx.match[1] as 'edit' | 'delete' | 'toggle';
      await ctx.answerCallbackQuery();
      await this.adminScene.showAdsList(ctx, action);
    });

    // Переключение активности
    bot.callbackQuery(/^admin:ad:toggle:(\d+)$/, async (ctx) => {
      const adId = parseInt(ctx.match[1]);
      await this.adminScene.toggleAd(ctx, adId);
    });

    // Удаление
    bot.callbackQuery(/^admin:ad:delete:(\d+)$/, async (ctx) => {
      const adId = parseInt(ctx.match[1]);
      await this.adminScene.deleteAd(ctx, adId);
    });

    // Редактирование
    bot.callbackQuery(/^admin:ad:edit:(\d+)$/, async (ctx) => {
      const adId = parseInt(ctx.match[1]);
      await this.adminScene.startEditAd(ctx, adId);
    });

    // Выбор поля для редактирования
    bot.callbackQuery(/^admin:ad:edit_field:(\d+):(\w+)$/, async (ctx) => {
      const adId = parseInt(ctx.match[1]);
      const field = ctx.match[2];
      await this.adminScene.editField(ctx, adId, field);
    });

    // Удаление медиа
    bot.callbackQuery(/^admin:ad:remove_media:(\d+)$/, async (ctx) => {
      const adId = parseInt(ctx.match[1]);
      await this.adminScene.removeMedia(ctx, adId);
    });

    // Удаление кнопки
    bot.callbackQuery(/^admin:ad:remove_button:(\d+)$/, async (ctx) => {
      const adId = parseInt(ctx.match[1]);
      await this.adminScene.removeButton(ctx, adId);
    });

    // Обновление интервала
    bot.callbackQuery(/^admin:ad:update_interval:(\d+):(\w+)$/, async (ctx) => {
      const adId = parseInt(ctx.match[1]);
      const interval = ctx.match[2];
      await this.adminScene.updateInterval(ctx, adId, interval);
    });

    // Выбор интервала при создании
    bot.callbackQuery(/^admin:ad:interval:(\w+)$/, async (ctx) => {
      const interval = ctx.match[1];
      await this.adminScene.handleIntervalChoice(ctx, interval);
    });

    // ==================== MANAGE CHANNELS ====================

    // Создание канала
    bot.callbackQuery('admin:channel:create', async (ctx) => {
      await this.adminScene.startCreateChannel(ctx);
    });

    // Выбор приоритета канала
    bot.callbackQuery(/^admin:channel:priority:(\d+)$/, async (ctx) => {
      const priority = ctx.match[1];
      await this.adminScene.handleChannelPriority(ctx, priority);
    });

    // Списки каналов для действий
    bot.callbackQuery(/^admin:channel:list:(toggle|delete)$/, async (ctx) => {
      const action = ctx.match[1] as 'toggle' | 'delete';
      await this.adminScene.showChannelsList(ctx, action);
    });

    // Переключение канала
    bot.callbackQuery(/^admin:channel:toggle:(\d+)$/, async (ctx) => {
      const channelId = parseInt(ctx.match[1]);
      await this.adminScene.toggleChannel(ctx, channelId);
    });

    // Удаление канала
    bot.callbackQuery(/^admin:channel:delete:(\d+)$/, async (ctx) => {
      const channelId = parseInt(ctx.match[1]);
      await this.adminScene.deleteChannel(ctx, channelId);
    });

    // ==================== USER COMMANDS ====================

    bot.command('start', async (ctx) => {

      if (ctx.chat?.type !== 'private') {
        // В группе просто подтверждаем работу, без проверок подписки
        await ctx.reply('👋 Ассаламу Алайкум! Я готов качать видео в этой группе. Кидайте ссылки!');
        return;
      }


      const startTime = Date.now();
      this.logger.log(
        `📥 /start от пользователя ${ctx.from?.id} - ${ctx.from?.username} - ${ctx.from?.first_name}`,
      );

      const userId = ctx.from?.id;
      if (!userId) return;

      try {
        const t1 = Date.now();
        await this.userService.createOrUpdate({
          id: BigInt(userId),
          username: ctx.from?.username,
          firstName: ctx.from?.first_name,
          lastName: ctx.from?.last_name,
        });
        this.logger.debug(`⏱️ createOrUpdate: ${Date.now() - t1}ms`);

        const t2 = Date.now();
        const [isBanned, hasSubscription] = await Promise.all([
          this.userService.isBanned(BigInt(userId)),
          this.subscriptionService.checkAll(userId, bot),
        ]);
        this.logger.debug(`⏱️ isBanned + checkAll: ${Date.now() - t2}ms`);

        if (isBanned) {
          await ctx.reply(MESSAGES.ERROR_BANNED);
          return;
        }

        if (!hasSubscription) {
          const t3 = Date.now();
          const keyboard =
            await this.subscriptionService.getSubscriptionKeyboard();
          this.logger.debug(`⏱️ getSubscriptionKeyboard: ${Date.now() - t3}ms`);

          await ctx.reply(MESSAGES.SUBSCRIBE_REQUIRED, {
            reply_markup: keyboard,
          });
          return;
        }

        const t4 = Date.now();
        await ctx.reply(MESSAGES.START, { parse_mode: 'Markdown' });
        this.logger.debug(`⏱️ ctx.reply: ${Date.now() - t4}ms`);

        this.logger.log(`✅ Ответ отправлен пользователю ${userId} (всего: ${Date.now() - startTime}ms)`);
      } catch (error) {
        this.logger.error('❌ Ошибка в /start:', error);
        await ctx.reply('❌ Произошла ошибка');
      }
    });

    bot.command('help', async (ctx) => {
      this.logger.log(`📥 /help от пользователя ${ctx.from?.id}`);

      try {
        await ctx.reply(
          `📖 **Помощь** \n\n` +
            `1️⃣ Отправь ссылку на видео\n` +
            `2️⃣ Выбери качество\n` +
            `3️⃣ Получи файл\n\n` +
            `Как пользоваться:\n` +
            `1. Зайди на страницу с интересным роликом (например - https://youtu.be/1baq1YaNsIA?si=Ljw_Ig6KIwxF4c71).\n` +
            `2. Нажми кнопку «Поделиться».\n` +
            `3. В открывшемся меню выбери - Telegram.\n` +
            `4. Когда откроется Telegram, нажми на чат с Yuklangan_bot!\n` +
            `Или просто вставь ссылку на ролик в чат и отправь ее боту.\n\n` +
            `⚡ Повторные запросы отправляются из кэша мгновенно!\n\n` +
            `🔗 Поддерживаемые платформы:\n` +
            `• YouTube  \n` +
            `• Instagram \n\n` +
            `Если есть вопросы или хотите сотрудничать — пишите Админу @Saidolimxoja`,
          { parse_mode: 'HTML' },
        );
      } catch (error) {
        console.error('❌ Ошибка в /help:', error);
      }
    });


    bot.command('channelid', async (ctx) => {
      console.log(`📥 /channelid от пользователя ${ctx.from?.id}`);

      try {
        await ctx.reply(`Chat ID: \`${ctx.chat?.id}\``, {
          parse_mode: 'Markdown',
        });
      } catch (error) {
        console.error('❌ Ошибка в /channelid:', error);
      }
    });
    // ==================== CHECK SUBSCRIPTION ====================

    // Обработка кнопки "✅ Проверить подписку"
    bot.callbackQuery('check_subscription', async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      // 1. Проверяем подписку через ваш сервис
      const isSubscribed = await this.subscriptionService.checkAll(userId, bot);

      if (isSubscribed) {
        // ✅ УСПЕХ: Пользователь подписался

        // 1. Показываем маленькое уведомление "Подписка подтверждена!"
        await ctx.answerCallbackQuery({
          text: MESSAGES.SUBSCRIBE_SUCCESS, // "✅ Подписка подтверждена!"
        });

        // 2. Удаляем сообщение с кнопками подписки (чтобы не мешало)
        try {
          await ctx.deleteMessage();
        } catch (e) {
          // Игнорируем, если сообщение уже удалено
        }

        // 3. Отправляем стартовое сообщение бота
        await ctx.reply(MESSAGES.START, { parse_mode: 'Markdown' });
      } else {
        // ❌ ОШИБКА: Пользователь НЕ подписался

        // Показываем ВСПЛЫВАЮЩЕЕ ОКНО (Alert), чтобы он точно понял
        await ctx.answerCallbackQuery({
          text: MESSAGES.SUBSCRIBE_FAILED, // "❌ Ты ещё не подписан на все каналы"
          show_alert: true, // <--- ВАЖНО: Это сделает окно с кнопкой "ОК"
        });

        // Сообщение в чате не меняем, пусть кнопки остаются
      }
    });

    // ==================== DOWNLOAD FLOW ====================

    bot.callbackQuery(/^dl\|(.+)$/, async (ctx) => {
      const [videoId, formatId, resolution] = ctx.match[1].split('|');

      this.logger.log(`📥 Выбор качества: ${resolution} от ${ctx.from?.id}`);

      await this.downloaderService.handleQualitySelection(
        ctx,
        bot,
        videoId,
        formatId,
        resolution,
      );
    });

    // ==================== MESSAGE HANDLERS ====================

    // Обработка фото и видео — принимаются ТОЛЬКО от админов
    // и только когда админ находится в соответствующей админ-сцене.
    bot.on(['message:photo', 'message:video'], async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      const state = this.adminScene.getState(userId);

      // Медиа имеет смысл только в этих двух состояниях админ-сцены.
      const isMediaState = state === 'waiting_for_media' || state === 'edit_media';

      if (isMediaState) {
        // Права проверяем в момент действия, а не полагаемся на то,
        // что до сюда дошли только «правильные» пользователи.
        const isAdmin = await this.isAdminSafe(userId);

        if (!isAdmin) {
          this.logger.warn(
            `⚠️ Не-админ ${userId} в админ-состоянии "${state}" — состояние сброшено`,
          );
          this.adminScene.resetState(userId);
          await this.handleUnsupportedMessage(ctx, ctx.message?.caption);
          return;
        }

        if (state === 'waiting_for_media') {
          await this.adminScene.handleAdMedia(ctx);
        } else {
          await this.adminScene.handleEditMedia(ctx);
        }
        return;
      }

      // Все остальные — обычная подсказка (в группах молчим).
      await this.replyUnsupportedInPrivate(ctx, ctx.message?.caption);
    });

    // Прочие типы сообщений (стикеры, голосовые, документы, аудио,
    // геолокация, контакты...) — админ-сцена их не использует,
    // поэтому просто подсказываем, что нужна ссылка.
    bot.on(
      [
        'message:sticker',
        'message:voice',
        'message:audio',
        'message:document',
        'message:animation',
        'message:video_note',
        'message:location',
        'message:contact',
      ],
      async (ctx) => {
        await this.replyUnsupportedInPrivate(ctx, ctx.message?.caption);
      },
    );

    // Обработка текстовых сообщений
    bot.on('message:text', async (ctx) => {
      const userId = ctx.from?.id;
      const text = ctx.message?.text;

      if (!userId || !text) return;

      const isGroup =
        ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';

      // ========== ГРУППЫ: только обработка ссылок ==========
      if (isGroup) {
        // В группах не нужны админ-сцены, подписки, бан-листы.
        // Просто ищем ссылки YouTube / Instagram и скачиваем.
        if (text.startsWith('/')) return; // Команды игнорируем

        const urls = this.extractSupportedUrls(text);
        if (urls.length === 0) return; // Нет подходящих ссылок — молчим

        this.logger.log(
          `📥 [ГРУППА ${ctx.chat.id}] Ссылки от ${userId}: ${urls.join(', ')}`,
        );

        for (const url of urls) {
          try {
            await this.downloaderService.handleUrl(ctx, url);
          } catch (error) {
            this.logger.error(
              `❌ Ошибка при обработке ссылки в группе: ${url}`,
              error,
            );
          }
        }
        return;
      }

      // ========== ПРИВАТНЫЙ ЧАТ: полная логика ==========

      // Проверяем состояние для создания объявления
      const state = this.adminScene.getState(userId);

      // 🔐 Если пользователь в админ-сцене — подтверждаем права в момент
      // действия. Запрос в БД делаем только здесь, а не на каждое сообщение.
      if (state && !(await this.isAdminSafe(userId))) {
        this.logger.warn(
          `⚠️ Не-админ ${userId} в админ-состоянии "${state}" — состояние сброшено`,
        );
        this.adminScene.resetState(userId);
        await this.handleUnsupportedMessage(ctx, text);
        return;
      }

      // ========== СОЗДАНИЕ ОБЪЯВЛЕНИЯ ==========
      if (state === 'waiting_for_content') {
        await this.adminScene.handleAdContent(ctx);
        return;
      }

      if (state === 'waiting_for_button_text') {
        await this.adminScene.handleButtonText(ctx);
        return;
      }

      if (state === 'waiting_for_button_url') {
        await this.adminScene.handleButtonUrl(ctx);
        return;
      }

      if (state === 'waiting_for_custom_interval') {
        await this.adminScene.handleCustomInterval(ctx);
        return;
      }

      // ========== РЕДАКТИРОВАНИЕ ОБЪЯВЛЕНИЯ ==========
      if (state === 'edit_content') {
        await this.adminScene.handleEditContent(ctx);
        return;
      }

      if (state === 'edit_interval_custom') {
        await this.adminScene.handleCustomInterval(ctx);
        return;
      }

      // ========== СОЗДАНИЕ КАНАЛА ==========
      if (state === 'waiting_for_channel_id') {
        await this.adminScene.handleChannelId(ctx);
        return;
      }

      if (state === 'waiting_for_channel_name') {
        await this.adminScene.handleChannelName(ctx);
        return;
      }

      // ✅✅✅ ВОТ ВАЖНАЯ ЧАСТЬ, КОТОРАЯ ИСПРАВЛЯЕТ ОШИБКУ ✅✅✅
      if (state === 'waiting_for_channel_link') {
        await this.adminScene.handleChannelLink(ctx);
        return;
      }

      // ========== ОБРАБОТКА КОМАНД ==========
      if (text.startsWith('/')) {
        return; // Команды обрабатываются отдельно
      }

      // ========== ОБРАБОТКА ССЫЛОК ==========
      // Тот же whitelist доменов, что и в группах — единая логика.
      const supportedUrls = this.extractSupportedUrls(text);
      if (supportedUrls.length === 0) {
        await this.handleUnsupportedMessage(ctx, text);
        return;
      }

      const url = supportedUrls[0];
      this.logger.log(`📥 Ссылка от пользователя ${userId}: ${url}`);

      try {
        const isBanned = await this.userService.isBanned(BigInt(userId));
        if (isBanned) {
          await ctx.reply(MESSAGES.ERROR_BANNED);
          return;
        }

        const hasSubscription = await this.subscriptionService.checkAll(
          userId,
          bot,
        );

        if (!hasSubscription) {
          const keyboard =
            await this.subscriptionService.getSubscriptionKeyboard();
          await ctx.reply(MESSAGES.SUBSCRIBE_REQUIRED, {
            reply_markup: keyboard,
          });
          return;
        }

        await this.downloaderService.handleUrl(ctx, url);
      } catch (error) {
        console.error('❌ Ошибка при обработке ссылки:', error);
        await ctx.reply('❌ Произошла ошибка');
      }
    });

    this.logger.log('✅ Все обработчики зарегистрированы');
  }

  private async startBot() {
    const bot = this.botService.getBot();
    this.logger.log('🚀 Запуск бота (параллельный runner)...');

    try {
      const botInfo = await bot.api.getMe();

      // run() запускает конкурентный long-polling и сразу возвращает управление
      this.runHandle = run(bot);

      console.log('\n ========================================');
      console.log(`   BOT STARTED: @${botInfo.username}`);
      console.log('========================================\n');
    } catch (error) {
      console.error('❌ Ошибка при запуске бота:', error);
      throw error;
    }
  }

  async onModuleDestroy() {
    try {
      if (this.runHandle?.isRunning()) {
        await this.runHandle.stop();
        this.logger.log('🛑 Runner остановлен');
      }
    } catch (error) {
      this.logger.warn('⚠️ Ошибка при остановке runner');
    }
  }

  /**
   * 🔗 Извлекает из текста все ссылки YouTube / Instagram.
   * Работает даже если ссылка вставлена в середине сообщения.
   */
  private extractSupportedUrls(text: string): string[] {
    const urlRegex = /https?:\/\/[^\s]+/gi;
    const allUrls = text.match(urlRegex) || [];

    return allUrls.filter((url) =>
      SUPPORTED_DOMAINS.some((domain) => url.includes(domain)),
    );
  }

  /**
   * 🔗 Извлекает из текста ВСЕ ссылки — включая неподдерживаемые.
   * Нужно, чтобы отличить «прислал ссылку на TikTok» от «прислал просто текст».
   */
  private extractAllUrls(text: string): string[] {
    return text.match(/https?:\/\/[^\s]+/gi) || [];
  }

  /**
   * 🏷 Достаёт домен из ссылки для человекочитаемого сообщения.
   * https://www.tiktok.com/@user/video/123 → tiktok.com
   */
  private getDomain(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return 'этого сайта';
    }
  }

  /**
   * 🔇 Антиспам: можно ли сейчас отправить подсказку этому пользователю?
   * Если да — сразу засекает время, чтобы следующий вызов был отклонён.
   */
  private canSendHint(userId: number): boolean {
    const now = Date.now();
    const last = this.lastHintAt.get(userId);

    if (last !== undefined && now - last < HINT_COOLDOWN_MS) {
      return false;
    }

    this.lastHintAt.set(userId, now);
    return true;
  }

  /**
   * 🔐 Проверка прав админа, устойчивая к сбоям БД.
   * При ошибке запроса возвращает false — «отказать» безопаснее, чем «разрешить».
   */
  private async isAdminSafe(userId: number): Promise<boolean> {
    try {
      return await this.userService.isAdmin(BigInt(userId));
    } catch (error) {
      this.logger.error(`❌ Не удалось проверить права ${userId}:`, error);
      return false;
    }
  }

  /**
   * 💬 Подсказка «нужна ссылка» — только в приватном чате.
   * В группах бот молчит: там он реагирует исключительно на ссылки.
   */
  private async replyUnsupportedInPrivate(
    ctx: Context,
    text?: string,
  ): Promise<void> {
    const isGroup =
      ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
    if (isGroup) return;

    await this.handleUnsupportedMessage(ctx, text);
  }

  /**
   * 💬 Единая точка ответа на всё, что НЕ является поддерживаемой ссылкой.
   *
   * Различает три случая:
   *  1. Не текст (фото, стикер, голосовое)      → NOT_A_TEXT_MESSAGE
   *  2. Текст со ссылкой на чужой домен          → UNSUPPORTED_DOMAIN(домен)
   *  3. Текст без ссылок вообще                  → NOT_A_LINK
   *
   * Все ответы проходят через антиспам-фильтр.
   */
  private async handleUnsupportedMessage(
    ctx: Context,
    text?: string,
  ): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    if (!this.canSendHint(userId)) {
      this.logger.debug(`🔇 Подсказка для ${userId} пропущена (кулдаун)`);
      return;
    }

    try {
      // Случай 1: пришло не текстовое сообщение
      if (!text) {
        await ctx.reply(MESSAGES.NOT_A_TEXT_MESSAGE);
        return;
      }

      // Случай 2: ссылка есть, но домен не наш
      const urls = this.extractAllUrls(text);
      if (urls.length > 0) {
        await ctx.reply(MESSAGES.UNSUPPORTED_DOMAIN(this.getDomain(urls[0])), {
          parse_mode: 'Markdown',
        });
        return;
      }

      // Случай 3: обычный текст без ссылок
      await ctx.reply(MESSAGES.NOT_A_LINK);
    } catch (error) {
      this.logger.warn(`⚠️ Не удалось отправить подсказку ${userId}:`, error);
    }
  }
}
