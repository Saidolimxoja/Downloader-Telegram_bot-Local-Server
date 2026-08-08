// src/common/constants/platform.constant.ts

/**
 * 🌐 ПОДДЕРЖИВАЕМЫЕ ПЛОЩАДКИ — ЕДИНЫЙ ИСТОЧНИК ПРАВДЫ
 *
 * Раньше список доменов был продублирован в bot.update.ts и в
 * downloader.service.ts, а тексты «я умею качать с...» — ещё и в
 * messages.constant.ts. Любая правка требовала помнить про все места.
 */
export const SUPPORTED_DOMAINS = [
  'youtube.com',
  'youtu.be',
  'instagram.com',
] as const;

/** Человекочитаемые названия для сообщений пользователю */
export const SUPPORTED_PLATFORM_NAMES = ['YouTube', 'Instagram'] as const;

/** Готовый маркированный список для вставки в тексты бота */
export const SUPPORTED_PLATFORMS_LIST = SUPPORTED_PLATFORM_NAMES.map(
  (name) => `• ${name}`,
).join('\n');

/** Ссылка ведёт на площадку, которую бот умеет обрабатывать? */
export function isSupportedUrl(url: string): boolean {
  return SUPPORTED_DOMAINS.some((domain) => url.includes(domain));
}

/** Достаёт домен для человекочитаемого сообщения: .../video/123 → tiktok.com */
export function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'этого сайта';
  }
}

/** Все http(s)-ссылки из текста — включая неподдерживаемые */
export function extractAllUrls(text: string): string[] {
  return text.match(/https?:\/\/[^\s]+/gi) || [];
}

/** Только ссылки на поддерживаемые площадки */
export function extractSupportedUrls(text: string): string[] {
  return extractAllUrls(text).filter(isSupportedUrl);
}
