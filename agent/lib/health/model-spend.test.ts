/**
 * Model spend tests.
 *
 * Constructs covered:
 * - A call is priced by DeepSeek's cache-hit, cache-miss and output rates, doubled in peak hours.
 * - Unknown models have no price instead of a guessed one.
 * - Digest lines: daily spend in dollars and the balance, a warning only when it is low or blocked.
 */
import { describe, expect, it } from "vitest";

import {
  formatDeepSeekBalance,
  formatModelSpend,
  isDeepSeekPeakHour,
  modelCallCostUsd,
} from "./model-spend.js";

describe("model spend", () => {
  it("treats 01–04 and 06–10 UTC on weekdays as peak and weekends as off-peak", () => {
    expect(isDeepSeekPeakHour(new Date("2026-09-14T01:00:00Z"))).toBe(true);
    expect(isDeepSeekPeakHour(new Date("2026-09-14T03:59:59Z"))).toBe(true);
    expect(isDeepSeekPeakHour(new Date("2026-09-14T04:00:00Z"))).toBe(false);
    expect(isDeepSeekPeakHour(new Date("2026-09-14T09:59:59Z"))).toBe(true);
    expect(isDeepSeekPeakHour(new Date("2026-09-14T10:00:00Z"))).toBe(false);
    expect(isDeepSeekPeakHour(new Date("2026-09-13T07:00:00Z"))).toBe(false);
  });

  it("prices a flash call by cache hits, misses and output", () => {
    const usage = { cacheHitTokens: 1_000_000, cacheMissTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(modelCallCostUsd("deepseek-v4-flash", usage, new Date("2026-09-14T12:00:00Z"))).toBeCloseTo(0.003 + 0.15 + 0.6, 9);
    expect(modelCallCostUsd("deepseek-v4.1-flash-expires-on-0910", usage, new Date("2026-09-14T07:00:00Z")))
      .toBeCloseTo(0.006 + 0.3 + 1.2, 9);
    expect(modelCallCostUsd("some-other-model", usage, new Date("2026-09-14T12:00:00Z"))).toBeNull();
  });

  it("describes the day's spend only when the model was called", () => {
    expect(formatModelSpend({ cacheHitTokens: 0, cacheMissTokens: 0, calls: 0, costUsd: 0, outputTokens: 0, unpricedCalls: 0, webSearchCalls: 0 }))
      .toBeNull();
    expect(formatModelSpend({
      cacheHitTokens: 1_680_000, cacheMissTokens: 320_000, calls: 24, costUsd: 0.1134,
      outputTokens: 12_400, unpricedCalls: 0, webSearchCalls: 5,
    })).toBe("Модель за сутки: 0,11 $, 24 вызова, вход мимо кэша 320 тыс., из кэша 84 %, выход 12 тыс., поисков 5.");
    expect(formatModelSpend({
      cacheHitTokens: 0, cacheMissTokens: 2_000, calls: 3, costUsd: 0, outputTokens: 100, unpricedCalls: 3, webSearchCalls: 0,
    })).toBe("Модель за сутки: 3 вызова без известной цены, вход мимо кэша 2 тыс., из кэша 0 %, выход 100.");
  });

  it("shows the balance as information and warns when it is low or the API refuses calls", () => {
    expect(formatDeepSeekBalance(null, 2)).toBeNull();
    expect(formatDeepSeekBalance({ available: true, totalUsd: 4.2 }, 2))
      .toEqual({ text: "DeepSeek: баланс 4,20 $.", warning: false });
    expect(formatDeepSeekBalance({ available: true, totalUsd: 1.5 }, 2)).toEqual({
      text: "DeepSeek: баланс 1,50 $, ниже порога 2,00 $. Пополните счёт, иначе бот перестанет отвечать.",
      warning: true,
    });
    expect(formatDeepSeekBalance({ available: false, totalUsd: -0.04 }, 2)).toEqual({
      text: "DeepSeek: запросы недоступны, баланс −0,04 $. Бот не может отвечать, пополните счёт.",
      warning: true,
    });
  });
});
