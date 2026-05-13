import * as Joi from 'joi';

export const validationSchema = Joi.object({
  // Bot
  BOT_TOKEN: Joi.string().required(),
  YOUR_USERNAME: Joi.string().required(),
  API_URL: Joi.string().default('http://localhost:8081'),

  // Telegram API (для локального сервера)
  API_ID: Joi.number().required(),
  API_HASH: Joi.string().required(),

  // Channels
  CHANNEL_ID: Joi.string().required(),

  // Database (Supabase PostgreSQL)
  DATABASE_URL: Joi.string().required(),

  // Redis
  REDIS_HOST: Joi.string().default('127.0.0.1'),
  REDIS_PORT: Joi.number().default(6379),

  // App
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().default(3000),

  // Paths
  YTDLP_PATH: Joi.string().default('yt-dlp'),
  DOWNLOADS_DIR: Joi.string().default('/tmp/bot_downloads'),

  // Queue
  MAX_PARALLEL_DOWNLOADS: Joi.number().default(3),
});
