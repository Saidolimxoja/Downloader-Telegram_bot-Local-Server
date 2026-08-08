// src/modules/bot/bot.update.ts

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { run, RunnerHandle, sequentialize } from '@grammyjs/runner';
import { Context } from 'grammy';
import { BotService } from './bot.service';
import { UserService } from '../user/user.service';
import { SubscriptionService } from '../subscription/subscription.service';
import { DownloaderService } from '../downloader/downloader.service';
import { ChannelService } from '../channel/channel.service';
import { AdminScene } from '../admin/admin.scene';
import { RedisService } from '../../common/redis/redis.service';
import { MESSAGES } from '../../common/constants/messages.constant';
import {
  REDIS_KEYS,
  REDIS_TTL,
} from '../../common/constants/redis-keys.constant';
import {
  extractAllUrls,
  extractSupportedUrls,
  getDomain,
} from '../../common/constants/platform.constant';
import { isBotRole } from '../../config/role';

@Injectable()
export class BotUpdate implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BotUpdate.name);
  private runHandle: RunnerHandle | null = null;

  constructor(
    private botService: BotService,
    private userService: UserService,
    private subscriptionService: SubscriptionService,
    private downloaderService: DownloaderService,
    private channelService: ChannelService,
    private adminScene: AdminScene,
    private redis: RedisService,
    private config: ConfigService,
  ) {}

  async onModuleInit() {
    // Воркеру обработчики не нужны: он не принимает апдейты, а только
    // разбирает очередь. Регистрировать их там — лишняя память и риск
    // случайно запустить второй long-polling с тем же токеном.
    if (!isBotRole()) {
      this.logger.log('⚙️ Роль worker: обработчики Telegram не регистрируются');
      return;
    }

    this.registerHandlers();
    await this.startBot();
  }

  private registerHandlers() {
    const bot = this.botService.getBot();
    this.logger.log('📝 Регистрация обработчиков...');

    // 🔀 Апдейты обрабатываются параллельно, но внутри одного чата —
    // строго по порядку, иначе админ-сцены ловили бы гонки состояний
    bot.use(
      sequentialize((ctx) => {
        const id = ctx.chat?.id ?? ctx.from?.id;
        return id === undefined ? undefined : id.toString();
      }),
    );

    // 🛡️ Ошибка в одном обработчике не должна ронять весь long-polling
    bot.catch((err) => {
      this.logger.error(`❌ Необработанная ошибка обработчика: ${err.message}`);
    });

    this.registerAdminHandlers(bot);
    this.registerUserCommands(bot);
    this.registerSubscriptionHandlers(bot);
    this.registerDownloadHandlers(bot);
    this.registerMessageHandlers(bot);

    this.logger.log('✅ Все обработчики зарегистрированы');
  }

  // ==================== АДМИНКА ====================

  private registerAdminHandlers(bot: ReturnType<BotService['getBot']>) {
    bot.command('admin', async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      if (!(await this.isAdminSafe(userId))) {
        await ctx.reply(MESSAGES.ERROR_NO_ACCESS);
        return;
      }

      await this.adminScene.showMainMenu(ctx);
    });

    bot.command('checkchannels', async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      if (!(await this.isAdminSafe(userId))) {
        await ctx.reply(MESSAGES.ERROR_NO_ACCESS);
        return;
      }

      try {
        const channels = await this.channelService.getActiveChannels();

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
            message += `   Название: ${chat.title}\n\n`;
          } catch (error: any) {
            message += `❌ ${channel.channelName}\n`;
            message += `   ID: \`${channel.channelId}\`\n`;
            message += `   Ошибка: ${error.message}\n\n`;
          }
        }

        await ctx.reply(message, { parse_mode: 'Markdown' });
      } catch (error: any) {
        this.logger.error(`❌ /checkchannels: ${error.message}`);
        await ctx.reply('❌ Ошибка проверки');
      }
    });

    // ---------- Навигация по меню ----------
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

    // ---------- Объявления ----------
    bot.callbackQuery('admin:ad:create', async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.adminScene.startCreateAd(ctx);
    });

    bot.callbackQuery('admin:ad:skip_media', (ctx) =>
      this.adminScene.skipMedia(ctx),
    );
    bot.callbackQuery('admin:ad:add_button', (ctx) =>
      this.adminScene.addButton(ctx),
    );
    bot.callbackQuery('admin:ad:skip_button', (ctx) =>
      this.adminScene.skipButton(ctx),
    );

    bot.callbackQuery(/^admin:ad:list:(edit|delete|toggle)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.adminScene.showAdsList(ctx, ctx.match[1] as any);
    });

    bot.callbackQuery(/^admin:ad:toggle:(\d+)$/, (ctx) =>
      this.adminScene.toggleAd(ctx, parseInt(ctx.match[1], 10)),
    );
    bot.callbackQuery(/^admin:ad:delete:(\d+)$/, (ctx) =>
      this.adminScene.deleteAd(ctx, parseInt(ctx.match[1], 10)),
    );
    bot.callbackQuery(/^admin:ad:edit:(\d+)$/, (ctx) =>
      this.adminScene.startEditAd(ctx, parseInt(ctx.match[1], 10)),
    );
    bot.callbackQuery(/^admin:ad:edit_field:(\d+):(\w+)$/, (ctx) =>
      this.adminScene.editField(ctx, parseInt(ctx.match[1], 10), ctx.match[2]),
    );
    bot.callbackQuery(/^admin:ad:remove_media:(\d+)$/, (ctx) =>
      this.adminScene.removeMedia(ctx, parseInt(ctx.match[1], 10)),
    );
    bot.callbackQuery(/^admin:ad:remove_button:(\d+)$/, (ctx) =>
      this.adminScene.removeButton(ctx, parseInt(ctx.match[1], 10)),
    );
    bot.callbackQuery(/^admin:ad:update_interval:(\d+):(\w+)$/, (ctx) =>
      this.adminScene.updateInterval(
        ctx,
        parseInt(ctx.match[1], 10),
        ctx.match[2],
      ),
    );
    bot.callbackQuery(/^admin:ad:interval:(\w+)$/, (ctx) =>
      this.adminScene.handleIntervalChoice(ctx, ctx.match[1]),
    );

    // ---------- Каналы ----------
    bot.callbackQuery('admin:channel:create', (ctx) =>
      this.adminScene.startCreateChannel(ctx),
    );
    bot.callbackQuery(/^admin:channel:priority:(\d+)$/, (ctx) =>
      this.adminScene.handleChannelPriority(ctx, ctx.match[1]),
    );
    bot.callbackQuery(/^admin:channel:list:(toggle|delete)$/, (ctx) =>
      this.adminScene.showChannelsList(ctx, ctx.match[1] as any),
    );
    bot.callbackQuery(/^admin:channel:toggle:(\d+)$/, (ctx) =>
      this.adminScene.toggleChannel(ctx, parseInt(ctx.match[1], 10)),
    );
    bot.callbackQuery(/^admin:channel:delete:(\d+)$/, (ctx) =>
      this.adminScene.deleteChannel(ctx, parseInt(ctx.match[1], 10)),
    );
  }

  // ==================== КОМАНДЫ ПОЛЬЗОВАТЕЛЯ ====================

  private registerUserCommands(bot: ReturnType<BotService['getBot']>) {
    bot.command('start', async (ctx) => {
      if (ctx.chat?.type !== 'private') {
        await ctx.reply(
          '👋 Ассаламу Алайкум! Я готов качать видео в этой группе. Кидайте ссылки!',
        );
        return;
      }

      const userId = ctx.from?.id;
      if (!userId) return;

      try {
        // Один upsert вместо связки SELECT + UPDATE/INSERT: пользователь
        // заведён, время активности обновлено, флаги получены
        const { isBanned } = await this.userService.ensureUser({
          id: BigInt(userId),
          username: ctx.from?.username,
          firstName: ctx.from?.first_name,
          lastName: ctx.from?.last_name,
        });

        if (isBanned) {
          await ctx.reply(MESSAGES.ERROR_BANNED);
          return;
        }

        const hasSubscription = await this.subscriptionService.checkAll(
          userId,
          bot,
        );

        if (!hasSubscription) {
          await ctx.reply(MESSAGES.SUBSCRIBE_REQUIRED, {
            reply_markup:
              await this.subscriptionService.getSubscriptionKeyboard(),
          });
          return;
        }

        await ctx.reply(MESSAGES.START, { parse_mode: 'Markdown' });
      } catch (error: any) {
        this.logger.error(`❌ /start: ${error.message}`);
        await ctx.reply('❌ Произошла ошибка');
      }
    });

    bot.command('help', async (ctx) => {
      await ctx.reply(MESSAGES.HELP(this.botUsername())).catch(() => {});
    });

    bot.command('channelid', async (ctx) => {
      await ctx
        .reply(`Chat ID: \`${ctx.chat?.id}\``, { parse_mode: 'Markdown' })
        .catch(() => {});
    });
  }

  // ==================== ПОДПИСКА ====================

  private registerSubscriptionHandlers(bot: ReturnType<BotService['getBot']>) {
    bot.callbackQuery('check_subscription', async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      // Сбрасываем кеш перед проверкой: человек только что подписался,
      // а закешированный ответ пятиминутной давности сказал бы «нет»
      await this.subscriptionService.invalidateUser(userId);

      const isSubscribed = await this.subscriptionService.checkAll(userId, bot);

      if (!isSubscribed) {
        await ctx.answerCallbackQuery({
          text: MESSAGES.SUBSCRIBE_FAILED,
          show_alert: true,
        });
        return;
      }

      await ctx.answerCallbackQuery({ text: MESSAGES.SUBSCRIBE_SUCCESS });
      await ctx.deleteMessage().catch(() => {});
      await ctx.reply(MESSAGES.START, { parse_mode: 'Markdown' });
    });
  }

  // ==================== ЗАГРУЗКА ====================

  private registerDownloadHandlers(bot: ReturnType<BotService['getBot']>) {
    bot.callbackQuery(/^dl\|(.+)$/, async (ctx) => {
      const [sessionId, formatId, resolution] = ctx.match[1].split('|');

      if (!sessionId || !formatId || !resolution) {
        await ctx.answerCallbackQuery({ text: '❌ Некорректная кнопка' });
        return;
      }

      await this.downloaderService.handleQualitySelection(
        ctx,
        sessionId,
        formatId,
        resolution,
      );
    });
  }

  // ==================== СООБЩЕНИЯ ====================

  private registerMessageHandlers(bot: ReturnType<BotService['getBot']>) {
    // Медиа принимаем только от админов и только внутри админ-сцены
    bot.on(['message:photo', 'message:video'], async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      const state = this.adminScene.getState(userId);
      const isMediaState =
        state === 'waiting_for_media' || state === 'edit_media';

      if (!isMediaState) {
        await this.replyUnsupportedInPrivate(ctx, ctx.message?.caption);
        return;
      }

      // Права проверяем в момент действия, а не полагаемся на то,
      // что до сюда дошли только «правильные» пользователи
      if (!(await this.isAdminSafe(userId))) {
        this.logger.warn(
          `⚠️ Не-админ ${userId} в состоянии "${state}" — сброс`,
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
    });

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
      (ctx) => this.replyUnsupportedInPrivate(ctx, ctx.message?.caption),
    );

    bot.on('message:text', async (ctx) => {
      const userId = ctx.from?.id;
      const text = ctx.message?.text;
      if (!userId || !text) return;

      const isGroup =
        ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';

      if (isGroup) {
        await this.handleGroupMessage(ctx, text, userId);
        return;
      }

      await this.handlePrivateMessage(ctx, text, userId, bot);
    });
  }

  /**
   * В группах бот молчалив: реагирует только на ссылки, без подписок и подсказок
   */
  private async handleGroupMessage(
    ctx: Context,
    text: string,
    userId: number,
  ): Promise<void> {
    if (text.startsWith('/')) return;

    const urls = extractSupportedUrls(text);
    if (urls.length === 0) return;

    this.logger.log(`📥 [Группа ${ctx.chat?.id}] ссылка от ${userId}`);

    // Обрабатываем только первую ссылку: пачка из десяти ссылок в одном
    // сообщении раньше порождала десять параллельных разборов
    try {
      await this.downloaderService.handleUrl(ctx, urls[0]);
    } catch (error: any) {
      this.logger.error(`❌ Ссылка в группе: ${error.message}`);
    }
  }

  private async handlePrivateMessage(
    ctx: Context,
    text: string,
    userId: number,
    bot: ReturnType<BotService['getBot']>,
  ): Promise<void> {
    const state = this.adminScene.getState(userId);

    if (state) {
      if (!(await this.isAdminSafe(userId))) {
        this.logger.warn(
          `⚠️ Не-админ ${userId} в состоянии "${state}" — сброс`,
        );
        this.adminScene.resetState(userId);
        await this.handleUnsupportedMessage(ctx, text);
        return;
      }

      if (await this.routeAdminState(ctx, state)) return;
    }

    if (text.startsWith('/')) return;

    const urls = extractSupportedUrls(text);
    if (urls.length === 0) {
      await this.handleUnsupportedMessage(ctx, text);
      return;
    }

    try {
      const { isBanned } = await this.userService.ensureUser({
        id: BigInt(userId),
        username: ctx.from?.username,
        firstName: ctx.from?.first_name,
        lastName: ctx.from?.last_name,
      });

      if (isBanned) {
        await ctx.reply(MESSAGES.ERROR_BANNED);
        return;
      }

      const hasSubscription = await this.subscriptionService.checkAll(
        userId,
        bot,
      );

      if (!hasSubscription) {
        await ctx.reply(MESSAGES.SUBSCRIBE_REQUIRED, {
          reply_markup:
            await this.subscriptionService.getSubscriptionKeyboard(),
        });
        return;
      }

      await this.downloaderService.handleUrl(ctx, urls[0]);
    } catch (error: any) {
      this.logger.error(`❌ Обработка ссылки: ${error.message}`);
      await ctx.reply('❌ Произошла ошибка').catch(() => {});
    }
  }

  /**
   * Разбор состояний админ-сцены. Возвращает true, если сообщение поглощено.
   * Таблица вместо десятка одинаковых if — добавление шага не требует
   * дописывать ещё одну ветку.
   */
  private async routeAdminState(ctx: Context, state: string): Promise<boolean> {
    const handlers: Record<string, () => Promise<void>> = {
      waiting_for_content: () => this.adminScene.handleAdContent(ctx),
      waiting_for_button_text: () => this.adminScene.handleButtonText(ctx),
      waiting_for_button_url: () => this.adminScene.handleButtonUrl(ctx),
      waiting_for_custom_interval: () =>
        this.adminScene.handleCustomInterval(ctx),
      edit_content: () => this.adminScene.handleEditContent(ctx),
      edit_interval_custom: () => this.adminScene.handleCustomInterval(ctx),
      waiting_for_channel_id: () => this.adminScene.handleChannelId(ctx),
      waiting_for_channel_name: () => this.adminScene.handleChannelName(ctx),
      waiting_for_channel_link: () => this.adminScene.handleChannelLink(ctx),
    };

    const handler = handlers[state];
    if (!handler) return false;

    await handler();
    return true;
  }

  // ==================== ЗАПУСК ====================

  private async startBot() {
    const bot = this.botService.getBot();
    this.logger.log('🚀 Запуск бота (параллельный runner)...');

    try {
      const botInfo = await bot.api.getMe();

      // Конкурентность приёма апдейтов ограничена: без потолка всплеск в
      // тысячу сообщений создал бы тысячу одновременных обработчиков
      this.runHandle = run(bot, {
        runner: {
          fetch: {
            allowed_updates: ['message', 'callback_query'],
          },
        },
        sink: {
          concurrency: parseInt(process.env.UPDATE_CONCURRENCY ?? '50', 10),
        },
      });

      this.logger.log(`✅ BOT STARTED: @${botInfo.username}`);
    } catch (error: any) {
      this.logger.error(`❌ Ошибка при запуске бота: ${error.message}`);
      throw error;
    }
  }

  async onModuleDestroy() {
    try {
      if (this.runHandle?.isRunning()) {
        await this.runHandle.stop();
        this.logger.log('🛑 Runner остановлен');
      }
    } catch {
      this.logger.warn('⚠️ Ошибка при остановке runner');
    }
  }

  // ==================== ВСПОМОГАТЕЛЬНОЕ ====================

  private botUsername(): string {
    return this.config.get<string>('YOUR_USERNAME') || '@your_bot';
  }

  /**
   * Проверка прав, устойчивая к сбоям БД: при ошибке отказываем.
   * «Не пустить админа» безопаснее, чем «пустить постороннего».
   */
  private async isAdminSafe(userId: number): Promise<boolean> {
    try {
      return await this.userService.isAdmin(BigInt(userId));
    } catch (error: any) {
      this.logger.error(`❌ Проверка прав ${userId}: ${error.message}`);
      return false;
    }
  }

  /**
   * Кулдаун подсказок теперь в Redis.
   *
   * Раньше это была Map, куда навсегда попадал каждый пользователь: десять
   * тысяч человек — десять тысяч записей, которые никто никогда не удалял.
   * SET NX EX делает то же самое одной командой и чистит за собой сам.
   */
  private async canSendHint(userId: number): Promise<boolean> {
    return this.redis.acquireLock(
      REDIS_KEYS.hintCooldown(userId),
      REDIS_TTL.hintCooldown,
    );
  }

  /** Подсказка «нужна ссылка» — только в личке, в группах бот молчит */
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
   * Единая точка ответа на всё, что не является поддерживаемой ссылкой:
   * не текст → сообщение о формате, чужой домен → какой именно,
   * просто текст → напоминание про ссылку. Всё под кулдауном.
   */
  private async handleUnsupportedMessage(
    ctx: Context,
    text?: string,
  ): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    if (!(await this.canSendHint(userId))) return;

    try {
      if (!text) {
        await ctx.reply(MESSAGES.NOT_A_TEXT_MESSAGE);
        return;
      }

      const urls = extractAllUrls(text);
      if (urls.length > 0) {
        await ctx.reply(MESSAGES.UNSUPPORTED_DOMAIN(getDomain(urls[0])), {
          parse_mode: 'Markdown',
        });
        return;
      }

      await ctx.reply(MESSAGES.NOT_A_LINK);
    } catch (error: any) {
      this.logger.warn(`⚠️ Подсказка ${userId}: ${error.message}`);
    }
  }
}
