/**
 * Область хода из проверенных атрибутов сессии.
 *
 * Экспорт:
 * - `SpaceAttributes`: пространство и версия его политики, доказанные ходом.
 * - `readSpaceAttributes`: разбор атрибутов; `undefined` означает прежний режим семьи.
 *
 * Атрибуты выставляет `telegram-turn-result.ts` из проверенного обновления Telegram и состояния
 * PostgreSQL, поэтому здесь остаётся только разбор формы. Ничто из текста модели сюда не попадает.
 */
import { z } from "zod";

import { AppError } from "../app-error.js";

export interface SpaceAttributes {
  readonly policyVersion: number;
  readonly spaceId: string;
}

const schema = z.object({
  policyVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  spaceId: z.string().uuid(),
}).strict();

/**
 * Наполовину заполненная область — это сбой производителя, а не прежний режим: версия без
 * пространства и пространство без версии одинаково означают, что доказательству верить нельзя.
 */
export function readSpaceAttributes(
  attributes: Readonly<Record<string, unknown>> | undefined,
  code = "AGENT_SPACE_CONTEXT_INVALID",
): SpaceAttributes | undefined {
  const spaceId = attributes?.spaceId;
  const version = attributes?.spacePolicyVersion;
  if (spaceId === undefined && version === undefined) return undefined;
  const parsed = schema.safeParse({
    policyVersion: typeof version === "string" ? Number(version) : Number.NaN,
    spaceId,
  });
  if (!parsed.success) {
    throw new AppError(code, "Не удалось проверить область текущего разговора");
  }
  return parsed.data;
}
