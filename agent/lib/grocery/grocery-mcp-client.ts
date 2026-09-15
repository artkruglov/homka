/**
 * Клиент каталога продуктов поверх MCP-эндпоинта источника.
 *
 * Экспорт:
 * - `callGroceryTool`: один вызов инструмента источника с разбором ответа.
 * - `createGroceryClient`: та же логика с подменяемым `fetch` для тестов.
 *
 * Почему свой клиент, а не подключение Eve: подключение регистрирует `connection_search` во всех
 * режимах сразу, мимо матрицы режимов этой установки, и не даёт обрезать ответ чужого сервера —
 * а он присылает состав и КБЖУ по каждому товару. Здесь инструмент живёт только в доверенных
 * чатах, а выдача приводится к нужным полям.
 *
 * Повторов нет: поиск дешёв, а ссылка на корзину создаётся у источника, и второй вызов создал бы
 * вторую корзину. Ошибка называется кодом, а человеку объясняется по-русски.
 */
import { AppError } from "../app-error.js";
import { GROCERY_MCP_URL, GROCERY_REQUEST_TIMEOUT_MS } from "./grocery-config.js";

interface GroceryClientDependencies {
  fetch: typeof fetch;
  timeoutMilliseconds: number;
  url: string;
}

function unavailable(diagnostic: string): AppError {
  console.error(JSON.stringify({ code: "AGENT_GROCERY_UNAVAILABLE", diagnostic }));
  return new AppError(
    "AGENT_GROCERY_UNAVAILABLE",
    "Каталог продуктов сейчас недоступен. Попробуйте позже",
  );
}

/** MCP поверх HTTP: один POST на вызов, без сессии, тело — JSON-RPC. */
export function createGroceryClient(dependencies: GroceryClientDependencies) {
  return async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
    let response: Response;
    try {
      response = await dependencies.fetch(dependencies.url, {
        body: JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "tools/call",
          params: { arguments: args, name },
        }),
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.timeout(dependencies.timeoutMilliseconds),
      });
    } catch (error) {
      throw unavailable(error instanceof Error ? error.name : "UnknownError");
    }
    if (response.status === 429) throw new AppError("AGENT_GROCERY_RATE_LIMITED", "ВкусВилл временно ограничил число запросов. Попробуйте позже");
    if (!response.ok) throw unavailable(`status_${response.status}`);

    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch {
      throw unavailable("body_not_json");
    }
    const message = envelope as {
      error?: { message?: unknown };
      result?: { content?: unknown; isError?: unknown };
    } | null;
    if (message?.error) throw unavailable("jsonrpc_error");
    if (message?.result?.isError === true) throw unavailable("tool_error");
    const content = message?.result?.content;
    const first = Array.isArray(content) ? content[0] as { text?: unknown } : null;
    if (typeof first?.text !== "string") throw unavailable("content_missing");
    let payload;
    try {
      payload = JSON.parse(first.text);
    } catch {
      throw new AppError("AGENT_GROCERY_RESPONSE_INVALID", "Каталог продуктов ответил непонятно");
    }
    if (payload?.ok === false) {
      if (payload.code === "rate_limited" || payload.error?.http_status === 429) {
        throw new AppError("AGENT_GROCERY_RATE_LIMITED", "ВкусВилл временно ограничил число запросов. Попробуйте позже");
      }
      throw unavailable("catalog_rejected");
    }
    return payload;
  };
}

export const callGroceryTool = createGroceryClient({
  fetch: (input, init) => fetch(input, init),
  timeoutMilliseconds: GROCERY_REQUEST_TIMEOUT_MS,
  url: GROCERY_MCP_URL,
});
