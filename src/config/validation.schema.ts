import * as Joi from 'joi';

export const validationSchema = Joi.object({
  // ===== Бот =====
  BOT_TOKEN: Joi.string().required(),
  YOUR_USERNAME: Joi.string().required(),
  API_URL: Joi.string().default('http://localhost:8081'),

  // Роль процесса: bot — приём сообщений, worker — разбор очередей,
  // all — всё сразу (по умолчанию, удобно для разработки)
  ROLE: Joi.string().valid('bot', 'worker', 'all').default('all'),

  // ===== Telegram API =====
  // Нужны КОНТЕЙНЕРУ локального Bot API server, а не самому приложению.
  // Раньше стояли required и роняли запуск бота там, где локальный сервер
  // поднят на хосте и этих переменных в .env приложения просто нет.
  API_ID: Joi.number().optional(),
  API_HASH: Joi.string().optional(),

  // ===== Каналы =====
  CHANNEL_ID: Joi.string().required(),

  // ===== База данных =====
  DATABASE_URL: Joi.string().required(),
  DIRECT_URL: Joi.string().optional(),

  // ===== Redis =====
  REDIS_HOST: Joi.string().default('127.0.0.1'),
  REDIS_PORT: Joi.number().default(6379),

  // ===== Приложение =====
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().default(3000),
  LOG_LEVEL: Joi.string().valid('error', 'warn', 'log', 'debug').optional(),

  // ===== Пути =====
  YTDLP_PATH: Joi.string().default('yt-dlp'),
  DOWNLOADS_DIR: Joi.string().default('./downloads'),
  COOKIES_PATH: Joi.string().default('./youtube_cookies.txt'),

  // ===== Очереди и параллелизм =====
  MAX_PARALLEL_DOWNLOADS: Joi.number().default(3),
  MAX_PARALLEL_ANALYSIS: Joi.number().default(5),
  MAX_QUEUE_SIZE: Joi.number().default(500),
  UPDATE_CONCURRENCY: Joi.number().default(50),

  // ===== Ограничения на пользователя =====
  RATE_LIMIT_PER_MINUTE: Joi.number().default(5),
  RATE_LIMIT_PER_HOUR: Joi.number().default(60),
  MAX_ACTIVE_ANALYSIS_PER_USER: Joi.number().default(2),

  // ===== Таймауты yt-dlp =====
  YTDLP_ANALYZE_TIMEOUT_MS: Joi.number().default(30_000),
  YTDLP_DOWNLOAD_TIMEOUT_MS: Joi.number().default(600_000),

  // ===== Уборка диска =====
  ORPHAN_FILE_MAX_AGE_MINUTES: Joi.number().default(120),
});
