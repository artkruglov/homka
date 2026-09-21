/**
 * Бережное обращение с открытым каталогом: кэш чтений, одна повторная попытка и пауза после отказа.
 *
 * Экспорт:
 * - `createGroceryCatalog`: обёртка над вызовом инструмента источника с подменяемыми часами и сном.
 * - `callGroceryCatalog`: рабочий экземпляр поверх `callGroceryTool`.
 *
 * Источник ВкусВилла открыт без ключа и делит общий ограничитель частоты со всеми, кто его нашёл.
 * Пока ограничение держится, новые запросы только тратят попытки, поэтому после отказа каталог
 * не опрашивается до конца паузы, а человек сразу слышит, сколько ждать. Чтения (поиск и карточка)
 * кэшируются и один раз повторяются после короткой паузы; создание ссылки на корзину не кэшируется
 * и не повторяется никогда — второй вызов создал бы вторую корзину.
 */
import { AppError } from "../app-error.js";
import {
  GROCERY_CACHE_MAX_ENTRIES,
  GROCERY_CACHE_TTL_MS,
  GROCERY_RATE_LIMIT_COOLDOWN_MS,
  GROCERY_READ_RETRY_DELAY_MS,
} from "./grocery-config.js";
import { callGroceryTool } from "./grocery-mcp-client.js";

/** Чтения источника: их безопасно повторить и показать из кэша. */
const READ_ONLY_TOOLS = new Set(["vkusvill_products_search", "vkusvill_product_details"]);

interface CatalogDependencies {
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}

function isRateLimited(error: unknown): boolean {
  return error instanceof AppError && error.code === "AGENT_GROCERY_RATE_LIMITED";
}

function waitMessage(milliseconds: number): AppError {
  const minutes = Math.max(1, Math.ceil(milliseconds / 60_000));
  return new AppError(
    "AGENT_GROCERY_RATE_LIMITED",
    `ВкусВилл ограничил число запросов. Каталог снова доступен примерно через ${minutes} мин`,
  );
}

export function createGroceryCatalog(dependencies: CatalogDependencies) {
  const cache = new Map<string, { expiresAt: number; payload: unknown }>();
  let cooldownUntil = 0;

  return async function catalog(name: string, args: Record<string, unknown>): Promise<unknown> {
    const readOnly = READ_ONLY_TOOLS.has(name);
    const key = readOnly ? `${name}:${JSON.stringify(args)}` : "";
    if (readOnly) {
      const hit = cache.get(key);
      if (hit && hit.expiresAt > dependencies.now()) return hit.payload;
      if (hit) cache.delete(key);
    }

    const remaining = cooldownUntil - dependencies.now();
    if (remaining > 0) {
      console.error(JSON.stringify({ code: "AGENT_GROCERY_RATE_LIMIT_COOLDOWN", remainingMs: remaining, tool: name }));
      throw waitMessage(remaining);
    }

    let payload: unknown;
    try {
      payload = await dependencies.call(name, args);
    } catch (error) {
      if (!isRateLimited(error)) throw error;
      // Одиночное совпадение запросов проходит после паузы; настоящий предел держится дольше.
      if (!readOnly) {
        cooldownUntil = dependencies.now() + GROCERY_RATE_LIMIT_COOLDOWN_MS;
        throw error;
      }
      await dependencies.sleep(GROCERY_READ_RETRY_DELAY_MS);
      try {
        payload = await dependencies.call(name, args);
      } catch (retryError) {
        if (isRateLimited(retryError)) {
          cooldownUntil = dependencies.now() + GROCERY_RATE_LIMIT_COOLDOWN_MS;
          throw waitMessage(GROCERY_RATE_LIMIT_COOLDOWN_MS);
        }
        throw retryError;
      }
    }

    cooldownUntil = 0;
    if (readOnly) {
      if (cache.size >= GROCERY_CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value!);
      cache.set(key, { expiresAt: dependencies.now() + GROCERY_CACHE_TTL_MS, payload });
    }
    return payload;
  };
}

export const callGroceryCatalog = createGroceryCatalog({
  call: callGroceryTool,
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
});
