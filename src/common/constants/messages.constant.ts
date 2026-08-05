export const MESSAGES = {
  // Start
  START: `✨ Добро пожаловать!  

Я помогу скачать видео или аудио с любой популярной платформы.  

Просто отправьте ссылку — и всё готово за несколько секунд! 🚀

📌 Поддерживаемые Платформы (YouTube, Instagram)`,

  // Errors
  ERROR_VIDEO_NOT_FOUND: '❌ Видео не найдено, отправь ссылку заново',
  ERROR_ANALYSIS: '❌ Ошибка анализа видео',
  ERROR_DOWNLOAD: '❌ Ошибка загрузки',
  ERROR_NO_ACCESS: '🚫 У вас нет доступа к этой команде',
  ERROR_BANNED: '🚫 Вы заблокированы',

  // Subscription
  SUBSCRIBE_REQUIRED: '❗ Для использования бота подпишись на эти каналы:',
  SUBSCRIBE_SUCCESS: '✅ Подписка подтверждена!',
  SUBSCRIBE_FAILED: '❌ Ты ещё не подписан на все каналы',

  // Progress
  ANALYZING: '🔍 Анализирую...',
  DOWNLOADING: '⬇️ Скачивание...',
  UPLOADING: '📤 Загружаю в канал...',
  COMPLETED: '✅ Готово!',

  // Cache
  FROM_CACHE: '⚡ Из кэша!',
  QUEUE_POSITION: (pos: number) => `⏳ Позиция в очереди: ${pos}`,
  ALREADY_DOWNLOADING: '⏳ Видео уже загружается, ждите...',

  // Fallback — сообщения, которые не являются поддерживаемой ссылкой
  NOT_A_LINK: `🤔 Я понимаю только ссылки!

Отправь ссылку на видео 👇

📌 Поддерживаемые платформы:
• YouTube
• Instagram`,

  UNSUPPORTED_DOMAIN: (domain: string) =>
    `❌ Ссылки с *${domain}* пока не поддерживаются.

📌 Я умею скачивать с:
• YouTube
• Instagram`,

  NOT_A_TEXT_MESSAGE: `📎 Я работаю только со ссылками на видео.

Отправь ссылку текстом 👇`,
};
