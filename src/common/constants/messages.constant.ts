// src/common/constants/messages.constant.ts

import { SUPPORTED_PLATFORMS_LIST } from './platform.constant';

/**
 * Список поддерживаемых площадок больше не переписывается руками в каждом
 * тексте — он собирается из единого реестра в platform.constant.ts.
 */
export const MESSAGES = {
  START: `✨ Добро пожаловать!

Я помогу скачать видео или аудио с популярных платформ.

Просто отправьте ссылку — и всё готово за несколько секунд! 🚀

📌 Поддерживаемые платформы:
${SUPPORTED_PLATFORMS_LIST}`,

  HELP: (botUsername: string) => `📖 *Помощь*

1️⃣ Отправь ссылку на видео
2️⃣ Выбери качество
3️⃣ Получи файл

Как пользоваться:
1. Открой страницу с роликом.
2. Нажми кнопку «Поделиться».
3. Выбери Telegram и чат с ботом ${botUsername}.

Или просто вставь ссылку в чат и отправь её боту.

⚡ Повторные запросы приходят из кэша мгновенно!

🔗 Поддерживаемые платформы:
${SUPPORTED_PLATFORMS_LIST}

По вопросам сотрудничества — @Saidolimxoja`,

  // Errors
  ERROR_VIDEO_NOT_FOUND: '❌ Видео не найдено, отправь ссылку заново',
  ERROR_ANALYSIS: '❌ Ошибка анализа видео',
  ERROR_DOWNLOAD: '❌ Ошибка загрузки',
  ERROR_NO_ACCESS: '🚫 У вас нет доступа к этой команде',
  ERROR_BANNED: '🚫 Вы заблокированы',
  ERROR_OVERLOADED:
    '🔥 Сейчас очень много запросов, и я не успеваю.\n\nПопробуй, пожалуйста, через несколько минут.',

  // Subscription
  SUBSCRIBE_REQUIRED: '❗ Для использования бота подпишись на эти каналы:',
  SUBSCRIBE_SUCCESS: '✅ Подписка подтверждена!',
  SUBSCRIBE_FAILED: '❌ Ты ещё не подписан на все каналы',

  // Progress
  ANALYZING: '🔍 Анализирую ссылку...',
  DOWNLOADING: '⬇️ Скачивание...',
  UPLOADING: '📤 Загружаю в Телеграм...',
  COMPLETED: '✅ Готово!',
  QUEUED: '📥 Видео в очереди!\n⏳ Я пришлю его, как только оно будет готово.',

  // Cache
  FROM_CACHE: '⚡ Из кэша!',

  // Fallback
  NOT_A_LINK: `🤔 Я понимаю только ссылки!

Отправь ссылку на видео 👇

📌 Поддерживаемые платформы:
${SUPPORTED_PLATFORMS_LIST}`,

  UNSUPPORTED_DOMAIN: (domain: string) =>
    `❌ Ссылки с *${domain}* пока не поддерживаются.

📌 Я умею скачивать с:
${SUPPORTED_PLATFORMS_LIST}`,

  NOT_A_TEXT_MESSAGE: `📎 Я работаю только со ссылками на видео.

Отправь ссылку текстом 👇`,
};
