// src/modules/downloader/interfaces/download-job.interface.ts

/** Имена очередей — в одном месте, чтобы строки не разъезжались */
export const ANALYZE_QUEUE = 'analyze-queue';
export const DOWNLOAD_QUEUE = 'download-queue';

/**
 * 🔍 ЗАДАЧА АНАЛИЗА ССЫЛКИ
 *
 * Раньше разбор ссылки шёл прямо в обработчике сообщения. Каждый вызов
 * поднимал процесс yt-dlp на 60-120 МБ, и ничто не ограничивало их число:
 * двести человек одновременно — двести процессов и OOM. Теперь анализ идёт
 * через очередь с фиксированной конкурентностью.
 */
export interface AnalyzeJobData {
  chatId: number;
  /** BigInt не переживает JSON — везде в задачах храним строкой */
  userId: string;
  url: string;
  /** Сообщение «Анализирую...», которое воркер превратит в результат */
  progressMsgId: number;
}

/**
 * ⬇️ ЗАДАЧА СКАЧИВАНИЯ
 *
 * Данные видео передаются не целиком, а идентификатором сессии: полный JSON
 * со всеми форматами весит десятки килобайт, и складывать его в Redis на
 * каждую задачу — лишняя нагрузка на очередь.
 */
export interface DownloadJobData {
  chatId: number;
  userId: string;
  sessionId: string;
  /** Прямая загрузка без выбора качества (Reels / Shorts) */
  isDirect: boolean;
  isInstagram: boolean;
  /** Только для загрузок с выбором качества */
  formatId?: string;
  resolution?: string;
  isAudio?: boolean;
  /** Сообщение, которое воркер переиспользует под прогресс */
  progressMsgId?: number;
}
