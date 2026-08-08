// src/modules/premium/premium.constants.ts

/**
 * 💎 ТАРИФЫ ПРЕМИУМА
 *
 * Оплата идёт в Telegram Stars (валюта XTR). Это нативные платежи Telegram:
 * не нужны ни эквайринг, ни платёжный провайдер, ни юрлицо — пользователь
 * платит внутри мессенджера.
 *
 * Цены в звёздах подобраны так, чтобы длинные тарифы были заметно выгоднее:
 * это подталкивает к покупке на большой срок и снижает отток.
 */
export interface PremiumPlan {
  /** Код тарифа — попадает в payload платежа */
  id: string;
  title: string;
  days: number;
  stars: number;
}

export const PREMIUM_PLANS: readonly PremiumPlan[] = [
  { id: 'week', title: '7 дней', days: 7, stars: 50 },
  { id: 'month', title: '30 дней', days: 30, stars: 150 },
  { id: 'quarter', title: '90 дней', days: 90, stars: 350 },
] as const;

export function findPlan(planId: string): PremiumPlan | undefined {
  return PREMIUM_PLANS.find((plan) => plan.id === planId);
}

/**
 * 🎁 РЕФЕРАЛЬНАЯ ПРОГРАММА
 *
 * Сколько дней премиума получает пригласивший за одного пришедшего.
 * Начисляется в момент первого /start приглашённого — не за «переход»,
 * а за реально заведённого пользователя.
 */
export const REFERRAL_REWARD_DAYS = 3;

/**
 * Что даёт премиум. Один список — и для текста пользователю, и как
 * напоминание разработчику, где именно проверяется подписка.
 */
export const PREMIUM_BENEFITS = [
  '🚫 Без рекламы',
  '🔓 Без обязательной подписки на каналы',
  '⚡ Приоритет в очереди — твои видео обрабатываются первыми',
  '📈 Повышенные лимиты на количество ссылок',
] as const;

/** Во сколько раз премиуму поднимаются лимиты на число ссылок */
export const PREMIUM_RATE_LIMIT_MULTIPLIER = 4;
