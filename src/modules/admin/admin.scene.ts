import { Injectable, Logger } from '@nestjs/common';
import { Context, InlineKeyboard } from 'grammy';
import { AdvertisementService } from '../advertisement/advertisement.service';
import { ChannelService } from '../channel/channel.service';
import { UserService } from '../user/user.service';
import { CreateAdDto } from '../advertisement/dto/create-ad.dto';
import { PrismaService } from 'src/database/prisma.service';
import { CacheService } from '../cache/cache.service';

interface TempAdData {
  content?: string;
  mediaFileId?: string;
  mediaType?: 'photo' | 'video';
  buttonText?: string;
  buttonUrl?: string;
  showInterval?: number;
}

interface TempChannelData {
  channelId?: string;
  channelName?: string;
  channelLink?: string;
  priority?: number;
}

@Injectable()
export class AdminScene {
  private readonly logger = new Logger(AdminScene.name);
  private readonly adminStates = new Map<number, string>();
  private readonly tempAdData = new Map<number, TempAdData>();
  private readonly tempChannelData = new Map<number, TempChannelData>();
  private readonly editAdId = new Map<number, number>();

  constructor(
    private advertisementService: AdvertisementService,
    private channelService: ChannelService,
    private userService: UserService,
    private prisma: PrismaService,
    private cacheService: CacheService,
  ) {}

  public getState(userId: number): string | undefined {
    return this.adminStates.get(userId);
  }

  // ============= СОЗДАНИЕ ОБЪЯВЛЕНИЯ =============

  async startCreateAd(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    this.adminStates.set(userId, 'waiting_for_content');
    this.tempAdData.set(userId, {});

    await ctx.reply('📝 Напиши контент объявления:', {
      reply_markup: new InlineKeyboard().text('❌ Отменить', 'admin:ads'),
    });
  }

  async handleAdContent(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !ctx.message?.text) {
      await ctx.reply('Пожалуйста, отправь текст');
      return;
    }

    const state = this.adminStates.get(userId);
    if (state !== 'waiting_for_content') return;

    const tempData = this.tempAdData.get(userId) || {};
    tempData.content = ctx.message.text;
    this.tempAdData.set(userId, tempData);

    this.adminStates.set(userId, 'waiting_for_media');

    const keyboard = new InlineKeyboard()
      .text('⏭ Пропустить (без медиа)', 'admin:ad:skip_media')
      .row()
      .text('❌ Отменить', 'admin:ads');

    await ctx.reply(
      '📸 Отправь фото или видео для объявления (или пропусти):',
      { reply_markup: keyboard },
    );
  }

  async handleAdMedia(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    const state = this.adminStates.get(userId);
    if (state !== 'waiting_for_media') return;

    const tempData = this.tempAdData.get(userId);
    if (!tempData) return;

    // Показываем что обрабатываем
    const processingMsg = await ctx.reply('⏳ Загружаю медиа...');

    if (ctx.message?.photo) {
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      tempData.mediaFileId = photo.file_id;
      tempData.mediaType = 'photo';
      await ctx.api.editMessageText(
        processingMsg.chat.id,
        processingMsg.message_id,
        '✅ Фото загружено!',
      );
    } else if (ctx.message?.video) {
      tempData.mediaFileId = ctx.message.video.file_id;
      tempData.mediaType = 'video';
      await ctx.api.editMessageText(
        processingMsg.chat.id,
        processingMsg.message_id,
        '✅ Видео загружено!',
      );
    } else {
      await ctx.api.deleteMessage(
        processingMsg.chat.id,
        processingMsg.message_id,
      );
      await ctx.reply('❌ Пожалуйста, отправь фото или видео');
      return;
    }

    this.tempAdData.set(userId, tempData);
    await this.askForButton(ctx, userId);
  }

  async skipMedia(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    await ctx.answerCallbackQuery();
    await this.askForButton(ctx, userId);
  }

  async askForButton(ctx: Context, userId: number): Promise<void> {
    this.adminStates.set(userId, 'waiting_for_button_choice');

    const keyboard = new InlineKeyboard()
      .text('✅ Да, добавить кнопку', 'admin:ad:add_button')
      .row()
      .text('⏭ Нет, без кнопки', 'admin:ad:skip_button')
      .row()
      .text('❌ Отменить', 'admin:ads');

    const message = '🔘 Добавить кнопку к объявлению?';

    if (ctx.callbackQuery) {
      await ctx.editMessageText(message, { reply_markup: keyboard });
    } else {
      await ctx.reply(message, { reply_markup: keyboard });
    }
  }

  async addButton(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    await ctx.answerCallbackQuery();
    this.adminStates.set(userId, 'waiting_for_button_text');

    const keyboard = new InlineKeyboard().text('❌ Отменить', 'admin:ads');

    await ctx.reply('📝 Напиши текст для кнопки:', {
      reply_markup: keyboard,
    });
  }

  async handleButtonText(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !ctx.message?.text) return;

    const state = this.adminStates.get(userId);
    if (state !== 'waiting_for_button_text') return;

    const tempData = this.tempAdData.get(userId);
    if (!tempData) return;

    tempData.buttonText = ctx.message.text;
    this.tempAdData.set(userId, tempData);

    this.adminStates.set(userId, 'waiting_for_button_url');

    const keyboard = new InlineKeyboard().text('❌ Отменить', 'admin:ads');

    await ctx.reply('🔗 Напиши URL для кнопки (начинается с https://):', {
      reply_markup: keyboard,
    });
  }

  async handleButtonUrl(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !ctx.message?.text) return;

    const state = this.adminStates.get(userId);
    if (state !== 'waiting_for_button_url') return;

    const url = ctx.message.text;

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      await ctx.reply('❌ URL должен начинаться с https:// или http://');
      return;
    }

    const tempData = this.tempAdData.get(userId);
    if (!tempData) return;

    tempData.buttonUrl = url;
    this.tempAdData.set(userId, tempData);

    await this.askForInterval(ctx, userId);
  }

  async skipButton(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    await ctx.answerCallbackQuery();
    await this.askForInterval(ctx, userId);
  }

  async askForInterval(ctx: Context, userId: number): Promise<void> {
    this.adminStates.set(userId, 'waiting_for_interval');

    const keyboard = new InlineKeyboard()
      .text('3 сообщения', 'admin:ad:interval:3')
      .text('5 сообщений', 'admin:ad:interval:5')
      .row()
      .text('10 сообщений', 'admin:ad:interval:10')
      .text('20 сообщений', 'admin:ad:interval:20')
      .row()
      .text('✏️ Свой интервал', 'admin:ad:interval:custom')
      .row()
      .text('❌ Отменить', 'admin:ads');

    const message = '⏱ Показывать объявление каждые N сообщений:';

    if (ctx.callbackQuery) {
      await ctx.editMessageText(message, { reply_markup: keyboard });
    } else {
      await ctx.reply(message, { reply_markup: keyboard });
    }
  }

  async handleIntervalChoice(ctx: Context, interval: string): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    await ctx.answerCallbackQuery();

    if (interval === 'custom') {
      this.adminStates.set(userId, 'waiting_for_custom_interval');
      await ctx.reply('📝 Введи интервал (число от 1 до 100):');
      return;
    }

    const tempData = this.tempAdData.get(userId);
    if (!tempData) return;

    tempData.showInterval = parseInt(interval);
    this.tempAdData.set(userId, tempData);

    await this.finalizeAd(ctx, userId);
  }

  async handleCustomInterval(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !ctx.message?.text) return;

    const state = this.adminStates.get(userId);
    if (state !== 'waiting_for_custom_interval') return;

    const interval = parseInt(ctx.message.text);

    if (isNaN(interval) || interval < 1 || interval > 100) {
      await ctx.reply('❌ Введи число от 1 до 100');
      return;
    }

    const tempData = this.tempAdData.get(userId);
    if (!tempData) return;

    tempData.showInterval = interval;
    this.tempAdData.set(userId, tempData);

    await this.finalizeAd(ctx, userId);
  }

  async finalizeAd(ctx: Context, userId: number): Promise<void> {
    const tempData = this.tempAdData.get(userId);
    if (!tempData || !tempData.content) {
      await ctx.reply('❌ Ошибка: данные объявления не найдены');
      return;
    }

    try {
      const createAdDto: CreateAdDto = {
        content: tempData.content,
        mediaFileId: tempData.mediaFileId,
        buttonText: tempData.buttonText,
        buttonUrl: tempData.buttonUrl,
        isActive: true,
        showInterval: tempData.showInterval || 5,
      };

      const ad = await this.advertisementService.create(createAdDto);

      this.adminStates.delete(userId);
      this.tempAdData.delete(userId);

      let preview = `✅ *Объявление создано!*\n\n`;
      preview += `📝 Контент: ${tempData.content}\n`;
      if (tempData.mediaFileId) {
        preview += `📸 Медиа: ${tempData.mediaType === 'photo' ? 'Фото' : 'Видео'}\n`;
      }
      if (tempData.buttonText && tempData.buttonUrl) {
        preview += `🔘 Кнопка: "${tempData.buttonText}" → ${tempData.buttonUrl}\n`;
      }
      preview += `⏱ Показ: каждые ${tempData.showInterval || 5} сообщений\n`;
      preview += `\n🆔 ID объявления: ${ad.id}`;

      const keyboard = new InlineKeyboard().text(
        '📣 К списку объявлений',
        'admin:ads',
      );

      await ctx.reply(preview, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
    } catch (error) {
      this.logger.error('Ошибка при создании объявления:', error);
      await ctx.reply('❌ Произошла ошибка при создании объявления');

      this.adminStates.delete(userId);
      this.tempAdData.delete(userId);
    }
  }

  // ============= РЕДАКТИРОВАНИЕ ОБЪЯВЛЕНИЯ =============

  async startEditAd(ctx: Context, adId: number): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    try {
      const ad = await this.advertisementService.findOne(adId);
      if (!ad) {
        await ctx.answerCallbackQuery({ text: '❌ Объявление не найдено' });
        return;
      }

      this.editAdId.set(userId, adId);

      const keyboard = new InlineKeyboard()
        .text('📝 Контент', `admin:ad:edit_field:${adId}:content`)
        .row()
        .text('📸 Медиа', `admin:ad:edit_field:${adId}:media`)
        .row()
        .text('🔘 Кнопка', `admin:ad:edit_field:${adId}:button`)
        .row()
        .text('⏱ Интервал', `admin:ad:edit_field:${adId}:interval`)
        .row()
        .text('« Назад', 'admin:ads');

      let message = `📝 *Редактирование объявления #${adId}*\n\n`;
      message += `Текущие данные:\n`;
      message += `• Контент: ${ad.content}\n`;
      message += `• Медиа: ${ad.mediaFileId ? '✅ Есть' : '❌ Нет'}\n`;
      message += `• Кнопка: ${ad.buttonText ? `"${ad.buttonText}"` : '❌ Нет'}\n`;
      message += `• Интервал: каждые ${ad.showInterval} сообщений\n\n`;
      message += `Что хочешь изменить?`;

      await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
      await ctx.answerCallbackQuery();
    } catch (error) {
      await ctx.answerCallbackQuery({ text: '❌ Ошибка' });
    }
  }

  async editField(ctx: Context, adId: number, field: string): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    await ctx.answerCallbackQuery();

    this.editAdId.set(userId, adId);
    this.adminStates.set(userId, `edit_${field}`);

    const messages = {
      content: '📝 Отправь новый текст объявления:',
      media: '📸 Отправь новое фото/видео или нажми "Удалить медиа":',
      button: '🔘 Отправь новый текст кнопки или нажми "Удалить кнопку":',
      interval: '⏱ Выбери новый интервал показа:',
    };

    if (field === 'interval') {
      await this.askForIntervalEdit(ctx, userId, adId);
    } else if (field === 'media') {
      const keyboard = new InlineKeyboard()
        .text('🗑 Удалить медиа', `admin:ad:remove_media:${adId}`)
        .row()
        .text('❌ Отменить', `admin:ad:edit:${adId}`);
      await ctx.reply(messages[field], { reply_markup: keyboard });
    } else if (field === 'button') {
      const keyboard = new InlineKeyboard()
        .text('🗑 Удалить кнопку', `admin:ad:remove_button:${adId}`)
        .row()
        .text('❌ Отменить', `admin:ad:edit:${adId}`);
      await ctx.reply(messages[field as keyof typeof messages], { reply_markup: keyboard });
    } else {
      await ctx.reply(messages[field as keyof typeof messages]);
    }
  }

  async askForIntervalEdit(
    ctx: Context,
    userId: number,
    adId: number,
  ): Promise<void> {
    const keyboard = new InlineKeyboard()
      .text('3', `admin:ad:update_interval:${adId}:3`)
      .text('5', `admin:ad:update_interval:${adId}:5`)
      .row()
      .text('10', `admin:ad:update_interval:${adId}:10`)
      .text('20', `admin:ad:update_interval:${adId}:20`)
      .row()
      .text('✏️ Свой', `admin:ad:update_interval:${adId}:custom`)
      .row()
      .text('❌ Отменить', `admin:ad:edit:${adId}`);

    await ctx.reply('⏱ Показывать каждые N сообщений:', {
      reply_markup: keyboard,
    });
  }

  async updateInterval(
    ctx: Context,
    adId: number,
    interval: string,
  ): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    await ctx.answerCallbackQuery();

    if (interval === 'custom') {
      this.adminStates.set(userId, 'edit_interval_custom');
      this.editAdId.set(userId, adId);
      await ctx.reply('📝 Введи интервал (1-100):');
      return;
    }

    try {
      await this.advertisementService.update(adId, {
        showInterval: parseInt(interval),
      });

      await ctx.reply(`✅ Интервал обновлен: каждые ${interval} сообщений`);
      await this.startEditAd(ctx, adId);
    } catch (error) {
      await ctx.reply('❌ Ошибка обновления');
    }
  }

  async handleEditContent(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !ctx.message?.text) return;

    const adId = this.editAdId.get(userId);
    if (!adId) return;

    try {
      await this.advertisementService.update(adId, {
        content: ctx.message.text,
      });

      this.adminStates.delete(userId);
      await ctx.reply('✅ Контент обновлен!');
    } catch (error) {
      await ctx.reply('❌ Ошибка обновления');
    }
  }

  async handleEditMedia(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    const adId = this.editAdId.get(userId);
    if (!adId) return;

    let mediaFileId: string | undefined;

    if (ctx.message?.photo) {
      mediaFileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    } else if (ctx.message?.video) {
      mediaFileId = ctx.message.video.file_id;
    } else {
      await ctx.reply('❌ Отправь фото или видео');
      return;
    }

    try {
      await this.advertisementService.update(adId, { mediaFileId });
      this.adminStates.delete(userId);
      await ctx.reply('✅ Медиа обновлено!');
    } catch (error) {
      await ctx.reply('❌ Ошибка обновления');
    }
  }

  async removeMedia(ctx: Context, adId: number): Promise<void> {
    try {
      await this.advertisementService.update(adId, { mediaFileId: undefined });
      await ctx.answerCallbackQuery({ text: '✅ Медиа удалено' });
      await this.startEditAd(ctx, adId);
    } catch (error) {
      await ctx.answerCallbackQuery({ text: '❌ Ошибка' });
    }
  }

  async removeButton(ctx: Context, adId: number): Promise<void> {
    try {
      await this.advertisementService.update(adId, {
        buttonText: undefined,
        buttonUrl: undefined,
      });
      await ctx.answerCallbackQuery({ text: '✅ Кнопка удалена' });
      await this.startEditAd(ctx, adId);
    } catch (error) {
      await ctx.answerCallbackQuery({ text: '❌ Ошибка' });
    }
  }

  // ============= УПРАВЛЕНИЕ КАНАЛАМИ =============

  async startCreateChannel(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    await ctx.answerCallbackQuery();

    this.adminStates.set(userId, 'waiting_for_channel_id');
    this.tempChannelData.set(userId, {});

    await ctx.reply(
      '🆔 Отправь ID канала (например: -1001234567890)\n\n' +
        'Чтобы получить ID канала:\n' +
        '1. Добавь бота в канал как админа\n' +
        '2. Отправь любое сообщение в канал\n' +
        '3. Перешли это сообщение сюда или используй @userinfobot',
      {
        reply_markup: new InlineKeyboard().text(
          '❌ Отменить',
          'admin:channels',
        ),
      },
    );
  }

  async handleChannelId(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !ctx.message?.text) return;

    const state = this.adminStates.get(userId);
    if (state !== 'waiting_for_channel_id') return;

    const channelId = ctx.message.text.trim();

    // Проверка формата ID
    if (!channelId.match(/^-?\d+$/)) {
      await ctx.reply(
        '❌ Неверный формат ID. Должно быть число (например: -1001234567890)',
      );
      return;
    }

    const tempData = this.tempChannelData.get(userId) || {};
    tempData.channelId = channelId;
    this.tempChannelData.set(userId, tempData);

    this.adminStates.set(userId, 'waiting_for_channel_name');

    await ctx.reply('📝 Теперь отправь название канала для отображения:');
  }

  async handleChannelName(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !ctx.message?.text) return;

    const state = this.adminStates.get(userId);
    if (state !== 'waiting_for_channel_name') return;

    const tempData = this.tempChannelData.get(userId);
    if (!tempData || !tempData.channelId) return;

    tempData.channelName = ctx.message.text;
    this.tempChannelData.set(userId, tempData);

    // --- ИЗМЕНЕНИЯ НАЧИНАЮТСЯ ЗДЕСЬ ---

    // Переводим в состояние ожидания ссылки
    this.adminStates.set(userId, 'waiting_for_channel_link');

    await ctx.reply(
      '🔗 Теперь отправь публичную ссылку на канал или юзернейм.\n' +
        'Примеры:\n' +
        '• https://t.me/channelname\n' +
        '• @channelname',
    );
  }

  async handleChannelLink(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !ctx.message?.text) return;

    const state = this.adminStates.get(userId);
    // Проверяем, что мы именно в этом состоянии
    if (state !== 'waiting_for_channel_link') return;

    let link = ctx.message.text.trim();

    // Логика обработки:
    if (link.startsWith('@')) {
      // Превращаем @channel в https://t.me/channel
      link = `https://t.me/${link.substring(1)}`;
    } else if (!link.startsWith('http')) {
      // Если прислали просто "channelname", считаем это юзернеймом
      link = `https://t.me/${link}`;
    }
    // Если ссылка уже начинается с https://t.me, оставляем как есть

    const tempData = this.tempChannelData.get(userId);
    if (!tempData) {
      await ctx.reply('❌ Ошибка данных. Начните создание канала заново.');
      this.adminStates.delete(userId);
      return;
    }

    // Сохраняем ссылку
    tempData.channelLink = link;
    this.tempChannelData.set(userId, tempData);

    // Переключаем состояние на следующее
    this.adminStates.set(userId, 'waiting_for_channel_priority');

    const keyboard = new InlineKeyboard()
      .text('1 (Высокий)', 'admin:channel:priority:1')
      .row()
      .text('2 (Средний)', 'admin:channel:priority:2')
      .row()
      .text('3 (Низкий)', 'admin:channel:priority:3')
      .row()
      .text('❌ Отменить', 'admin:channels');

    await ctx.reply(
      `🔗 Ссылка принята: ${link}\n\n🔢 Теперь выбери приоритет канала:`,
      { reply_markup: keyboard },
    );
  }

  async toggleChannel(ctx: Context, channelId: number): Promise<void> {
    try {
      const channel = await this.channelService.toggle(channelId);
      const status = channel.isActive ? 'активирован' : 'деактивирован';

      await ctx.answerCallbackQuery({ text: `✅ Канал ${status}` });
      await this.showChannelsMenu(ctx);
    } catch (error) {
      await ctx.answerCallbackQuery({ text: '❌ Ошибка' });
    }
  }
  async handleChannelPriority(ctx: Context, priority: string): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    await ctx.answerCallbackQuery();

    const tempData = this.tempChannelData.get(userId);

    // Проверка наличия всех данных
    if (
      !tempData ||
      !tempData.channelId ||
      !tempData.channelName ||
      !tempData.channelLink
    ) {
      await ctx.reply(
        '❌ Ошибка: данные устарели. Пожалуйста, начните добавление канала заново.',
      );
      return;
    }

    try {
      await this.channelService.create({
        channelId: tempData.channelId,
        channelName: tempData.channelName,
        priority: parseInt(priority),
        channelLink: tempData.channelLink,
      });

      this.adminStates.delete(userId);
      this.tempChannelData.delete(userId);

      // 👇 ИСПРАВЛЕНИЕ ЗДЕСЬ: Используем HTML вместо Markdown 👇
      await ctx.reply(
        `✅ <b>Канал добавлен!</b>\n\n` +
          `📢 ${tempData.channelName}\n` +
          `🔗 ${tempData.channelLink}\n` +
          `🆔 <code>${tempData.channelId}</code>\n` +
          `🔢 Приоритет: ${priority}`,
        { parse_mode: 'HTML' }, // <--- Меням Markdown на HTML
      );

      await this.showChannelsMenu(ctx);
    } catch (error) {
      this.logger.error('Ошибка создания канала:', error);
      await ctx.reply('❌ Ошибка при добавлении канала');
    }
  }

  async deleteChannel(ctx: Context, channelId: number): Promise<void> {
    try {
      await this.channelService.delete(channelId);
      await ctx.answerCallbackQuery({ text: '✅ Канал удален' });
      await this.showChannelsMenu(ctx);
    } catch (error) {
      await ctx.answerCallbackQuery({ text: '❌ Ошибка' });
    }
  }

  async showChannelsList(
    ctx: Context,
    action: 'toggle' | 'delete',
  ): Promise<void> {
    const channels = await this.channelService.getAll();

    if (channels.length === 0) {
      await ctx.answerCallbackQuery({ text: 'Нет каналов' });
      return;
    }

    const keyboard = new InlineKeyboard();

    channels.forEach((channel) => {
      const status = channel.isActive ? '✅' : '❌';
      keyboard
        .text(
          `${status} ${channel.channelName}`,
          `admin:channel:${action}:${channel.id}`,
        )
        .row();
    });

    keyboard.text('« Назад', 'admin:channels');

    const actionText = {
      toggle: 'переключения',
      delete: 'удаления',
    }[action];

    await ctx.editMessageText(`Выберите канал для ${actionText}:`, {
      reply_markup: keyboard,
    });
    await ctx.answerCallbackQuery();
  }

  // ============= ГЛАВНОЕ МЕНЮ =============

  async showMainMenu(ctx: Context): Promise<void> {
    const keyboard = new InlineKeyboard()
      .text('📣 Управление рекламой', 'admin:ads')
      .row()
      .text('📢 Управление каналами', 'admin:channels')
      .row()
      .text('📊 Статистика', 'admin:stats');

    await ctx.reply('⚙️ *Админ-панель*', {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
  }

  async showAdsMenu(ctx: Context): Promise<void> {
    const ads = await this.advertisementService.getAll();
    const stats = await this.advertisementService.getTotalStats();

    let message = `📣 *Реклама*\n\n`;
    message += `📊 Общая статистика:\n`;
    message += `• Всего объявлений: ${stats.totalAds}\n`;
    message += `• Активных: ${stats.activeAds}\n`;
    message += `• Просмотров: ${stats.totalViews}\n`;
    message += `• Кликов: ${stats.totalClicks}\n`;
    message += `• CTR: ${stats.ctr}\n\n`;

    if (ads.length > 0) {
      message += `*Объявления:*\n\n`;
      for (const ad of ads) {
        const status = ad.isActive ? '✅' : '❌';
        const preview =
          ad.content.substring(0, 30) + (ad.content.length > 30 ? '...' : '');
        message += `${status} ID:${ad.id} - ${preview}\n`;
        message += `   👁 ${ad.viewCount} | 👆 ${ad.clickCount} | ⏱ каждые ${ad.showInterval} сообщений\n\n`;
      }
    } else {
      message += `_Нет объявлений_\n\n`;
    }

    const keyboard = new InlineKeyboard()
      .text('➕ Создать объявление', 'admin:ad:create')
      .row()
      .text('📝 Редактировать', 'admin:ad:list:edit')
      .text('🗑 Удалить', 'admin:ad:list:delete')
      .row()
      .text('🔄 Вкл/Выкл', 'admin:ad:list:toggle')
      .row()
      .text('« Назад', 'admin:main');

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
  }

  async showAdsList(
    ctx: Context,
    action: 'edit' | 'delete' | 'toggle',
  ): Promise<void> {
    const ads = await this.advertisementService.getAll();

    if (ads.length === 0) {
      await ctx.answerCallbackQuery({ text: 'Нет объявлений' });
      return;
    }

    const keyboard = new InlineKeyboard();

    ads.forEach((ad) => {
      const status = ad.isActive ? '✅' : '❌';
      const preview = ad.content.substring(0, 20);
      keyboard
        .text(`${status} ${ad.id}: ${preview}`, `admin:ad:${action}:${ad.id}`)
        .row();
    });

    keyboard.text('« Назад', 'admin:ads');

    const actionText = {
      edit: 'редактирования',
      delete: 'удаления',
      toggle: 'переключения',
    }[action];

    await ctx.editMessageText(`Выберите объявление для ${actionText}:`, {
      reply_markup: keyboard,
    });
  }

  async toggleAd(ctx: Context, adId: number): Promise<void> {
    try {
      const ad = await this.advertisementService.toggleActive(adId);
      const status = ad.isActive ? 'активировано' : 'деактивировано';

      await ctx.answerCallbackQuery({ text: `✅ Объявление ${status}` });
      await this.showAdsMenu(ctx);
    } catch (error) {
      await ctx.answerCallbackQuery({ text: '❌ Ошибка' });
    }
  }

  async deleteAd(ctx: Context, adId: number): Promise<void> {
    try {
      await this.advertisementService.delete(adId);
      await ctx.answerCallbackQuery({ text: '✅ Объявление удалено' });
      await this.showAdsMenu(ctx);
    } catch (error) {
      await ctx.answerCallbackQuery({ text: '❌ Ошибка' });
    }
  }

  async showChannelsMenu(ctx: Context): Promise<void> {
    const channels = await this.channelService.getAll();

let message = `📢 *__ОБЯЗАТЕЛЬНЫЕ КАНАЛЫ__*\n\n`;

    if (channels.length > 0) {
      for (const channel of channels) {
        const status = channel.isActive ? '✅' : '❌';
        message += `${status} *${channel.channelName}*\n`;
        message += `   ID: \`${channel.channelId}\`\n`;
        message += `   Приоритет: ${channel.priority}\n\n`;
        message += `   🔗 [Ссылка на канал](${channel.channelLink})\n\n`;
      }
    } else {
      message += `_*Нет каналов*_`;
    }

    const keyboard = new InlineKeyboard()
      .text('➕ Добавить канал', 'admin:channel:create')
      .row()
      .text('🔄 Вкл/Выкл', 'admin:channel:list:toggle')
      .text('🗑 Удалить', 'admin:channel:list:delete')
      .row()
      .text('« Назад', 'admin:main');

    await ctx.editMessageText(message, {
      parse_mode: 'MarkdownV2',
      reply_markup: keyboard,
    });
  }

  async showStats(ctx: Context): Promise<void> {
    const userStats = await this.userService.getStats();
    const adStats = await this.advertisementService.getTotalStats();
    const sessionsCount = await this.prisma.videoSession.count();
    const cacheStats = await this.cacheService.getStats();

    const message =
      `📊 *Статистика бота*\n\n` +
      `👥 *Пользователи:*\n` +
      `• Всего: ${userStats.totalUsers}\n` +
      `• Активных сегодня: ${userStats.activeToday}\n` +
      `• Видео-сессий: ${sessionsCount}\n` +
      `• Кеш: ${cacheStats.totalFiles}\n\n` +
      `📣 *Реклама:*\n` +
      `• Объявлений: ${adStats.totalAds} (${adStats.activeAds} активных)\n` +
      `• Просмотров: ${adStats.totalViews}\n` +
      `• Кликов: ${adStats.totalClicks}\n` +
      `• CTR: ${adStats.ctr}`;

    const keyboard = new InlineKeyboard().text('« Назад', 'admin:main');

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
  }
}
