// src/config/role.ts

/**
 * 🎭 РОЛЬ ПРОЦЕССА
 *
 * Раньше один процесс делал всё сразу: держал long-polling Telegram и тут же
 * запускал yt-dlp с ffmpeg. Из-за этого бот тормозил под нагрузкой (перекодировка
 * съедает ядро целиком), а масштабировать было нельзя вообще: второй инстанс
 * ловил 409 Conflict на getUpdates.
 *
 * Теперь роль задаётся переменной ROLE:
 *   bot    — только приём сообщений и постановка задач в очередь (ровно 1 инстанс)
 *   worker — только выполнение задач из очереди (масштабируется репликами)
 *   all    — всё вместе, удобно для локальной разработки (по умолчанию)
 *
 * Читаем из process.env напрямую, а не через ConfigService: значение нужно на
 * этапе построения модулей, до того как DI-контейнер собран.
 */
export type AppRole = 'bot' | 'worker' | 'all';

export function getRole(): AppRole {
  const raw = (process.env.ROLE || 'all').toLowerCase().trim();

  if (raw === 'bot' || raw === 'worker' || raw === 'all') {
    return raw;
  }

  // Неизвестное значение — безопаснее поднять всё, чем молча ничего не делать
  return 'all';
}

/** Процесс принимает апдейты Telegram? */
export function isBotRole(): boolean {
  const role = getRole();
  return role === 'bot' || role === 'all';
}

/** Процесс разбирает очередь задач? */
export function isWorkerRole(): boolean {
  const role = getRole();
  return role === 'worker' || role === 'all';
}

/**
 * Процесс отвечает за периодические задачи (очистка кеша, сессий, диска)?
 *
 * Привязано к роли bot, а не worker: бот всегда существует ровно в одном
 * экземпляре, а воркеров может быть пять — крон бы отработал пять раз.
 */
export function isCronRole(): boolean {
  return isBotRole();
}
