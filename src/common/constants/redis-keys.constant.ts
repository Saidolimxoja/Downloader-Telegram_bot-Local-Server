// src/common/constants/redis-keys.constant.ts

/**
 * 🔑 ЕДИНЫЙ РЕЕСТР КЛЮЧЕЙ REDIS
 *
 * Ключи собираются здесь, а не разбросаны по сервисам: так видно всю схему
 * хранения разом и невозможно случайно занять одно имя дважды.
 */
export const REDIS_KEYS = {
  /** Кеш проверки подписки: подписан ли пользователь на обязательные каналы */
  subscription: (userId: number | bigint) => `sub:${userId}`,
  /** Маска для сброса всех проверок разом при смене списка каналов */
  subscriptionPattern: 'sub:*',

  /** Счётчик загрузок пользователя между показами рекламы */
  adCounter: (userId: bigint) => `ad:count:${userId}`,

  /** Кулдаун подсказки «пришли ссылку» */
  hintCooldown: (userId: number) => `hint:${userId}`,

  /** Сколько задач пользователя сейчас в работе (защита от захвата очереди) */
  activeJobs: (userId: bigint) => `jobs:active:${userId}`,

  /** Окно rate limit: сколько ссылок пользователь прислал за период */
  rateLimit: (userId: bigint, window: string) => `rl:${window}:${userId}`,

  /** Данные проанализированного видео под кнопками выбора качества */
  videoSession: (sessionId: string) => `vs:${sessionId}`,

  /** Блокировка на скачивание конкретного видео в конкретном качестве */
  downloadLock: (cacheKey: string) => `dl:lock:${cacheKey}`,
} as const;

/** ⏱ Сроки жизни ключей, в секундах */
export const REDIS_TTL = {
  /** Проверка подписки — 5 минут, как было в памяти */
  subscription: 5 * 60,
  /** Счётчик рекламы — 30 дней, переживает рестарты */
  adCounter: 30 * 24 * 60 * 60,
  /** Кулдаун подсказки */
  hintCooldown: 30,
  /** Страховка от зависших счётчиков активных задач */
  activeJobs: 30 * 60,
  /** Сессия видео: кнопки старше суток всё равно бессмысленны */
  videoSession: 24 * 60 * 60,
  /** Блокировка скачивания — чуть больше максимального времени загрузки */
  downloadLock: 10 * 60,
} as const;
