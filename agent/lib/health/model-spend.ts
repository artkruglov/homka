/**
 * Money spent on the model, as the owner reads it.
 *
 * Exports:
 * - `isDeepSeekPeakHour`: whether DeepSeek bills a moment at peak rates.
 * - `modelCallCostUsd`: price of one call from cache hits, misses and output, or null when unknown.
 * - `ModelSpendSummary` / `formatModelSpend`: the digest line for the last day.
 * - `DeepSeekBalance` / `formatDeepSeekBalance`: the balance line and whether it is a warning.
 *
 * Key constructs:
 * - 14 September 2026 the DeepSeek balance reached −0.04 $ and the bot lost its model before anyone
 *   noticed. Tokens alone misled the analysis: a cache hit costs fifty times less than a miss, so
 *   the digest speaks in dollars and keeps the miss/hit split next to them.
 * - Prices come from api-docs.deepseek.com/quick_start/pricing (checked 14 September 2026); an
 *   unlisted model gets no price rather than a guessed one.
 */
export interface ModelCallUsage {
  readonly cacheHitTokens: number;
  readonly cacheMissTokens: number;
  readonly outputTokens: number;
}

interface PricePerMillionUsd {
  readonly cacheHit: number;
  readonly cacheMiss: number;
  readonly output: number;
}

/** Off-peak rates; peak hours double every component. */
const DEEPSEEK_FLASH_OFF_PEAK: PricePerMillionUsd = { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 };
const PEAK_MULTIPLIER = 2;

export function isDeepSeekPeakHour(at: Date): boolean {
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = at.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

function priceFor(modelId: string): PricePerMillionUsd | null {
  // Flash ids: deepseek-v4-flash, the dated v4.1 preview alias and the vision experiment.
  return /^deepseek-v4(?:\.\d+)?-flash/u.test(modelId) ? DEEPSEEK_FLASH_OFF_PEAK : null;
}

export function modelCallCostUsd(modelId: string, usage: ModelCallUsage, at: Date): number | null {
  const price = priceFor(modelId);
  if (price === null) return null;
  const multiplier = isDeepSeekPeakHour(at) ? PEAK_MULTIPLIER : 1;
  return multiplier * (
    usage.cacheHitTokens * price.cacheHit +
    usage.cacheMissTokens * price.cacheMiss +
    usage.outputTokens * price.output
  ) / 1_000_000;
}

export interface ModelSpendSummary {
  readonly cacheHitTokens: number;
  readonly cacheMissTokens: number;
  readonly calls: number;
  readonly costUsd: number;
  readonly outputTokens: number;
  readonly unpricedCalls: number;
  readonly webSearchCalls: number;
}

export interface DeepSeekBalance {
  readonly available: boolean;
  readonly totalUsd: number;
}

function decimal(value: number, digits: number): string {
  const text = Math.abs(value).toFixed(digits).replace(".", ",");
  return value < 0 ? `−${text}` : text;
}

function tokens(count: number): string {
  if (count >= 1_000_000) return `${decimal(count / 1_000_000, 2)} млн`;
  if (count >= 1_000) return `${Math.round(count / 1_000)} тыс.`;
  return String(count);
}

function calls(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  const word = lastTwo >= 11 && lastTwo <= 14 ? "вызовов" : last === 1 ? "вызов" : last >= 2 && last <= 4 ? "вызова" : "вызовов";
  return `${count} ${word}`;
}

export function formatModelSpend(summary: ModelSpendSummary): string | null {
  if (summary.calls === 0) return null;
  const input = summary.cacheHitTokens + summary.cacheMissTokens;
  const cachedPercent = input === 0 ? 0 : Math.round(summary.cacheHitTokens / input * 100);
  const priced = summary.calls - summary.unpricedCalls;
  const head = priced === 0
    ? `${calls(summary.calls)} без известной цены`
    : `${decimal(summary.costUsd, 2)} $, ${calls(summary.calls)}` +
      (summary.unpricedCalls > 0 ? ` (${summary.unpricedCalls} без известной цены)` : "");
  return `Модель за сутки: ${head}, вход мимо кэша ${tokens(summary.cacheMissTokens)}, из кэша ${cachedPercent} %, ` +
    `выход ${tokens(summary.outputTokens)}` + (summary.webSearchCalls > 0 ? `, поисков ${summary.webSearchCalls}` : "") + ".";
}

export function formatDeepSeekBalance(
  balance: DeepSeekBalance | null,
  thresholdUsd: number,
): { text: string; warning: boolean } | null {
  if (balance === null) return null;
  if (!balance.available) {
    return {
      text: `DeepSeek: запросы недоступны, баланс ${decimal(balance.totalUsd, 2)} $. Бот не может отвечать, пополните счёт.`,
      warning: true,
    };
  }
  if (balance.totalUsd < thresholdUsd) {
    return {
      text: `DeepSeek: баланс ${decimal(balance.totalUsd, 2)} $, ниже порога ${decimal(thresholdUsd, 2)} $. ` +
        "Пополните счёт, иначе бот перестанет отвечать.",
      warning: true,
    };
  }
  return { text: `DeepSeek: баланс ${decimal(balance.totalUsd, 2)} $.`, warning: false };
}
