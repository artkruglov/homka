/**
 * Доказательство адресата проактивной доставки.
 *
 * Экспорт:
 * - `SpaceDestination`: семья, чат и область строки, заведённой прежним ходом.
 * - `isSpaceDestinationProven`: держится ли аудитория этой области в этом чате прямо сейчас.
 *
 * У проактивной доставки нет хода, который доказал бы область: строку завёл ход, закончившийся
 * часы назад. Поэтому аудитория доказывается заново непосредственно перед отправкой и той же
 * функцией `resolveSpaceAccess`, что и в разговоре: второй предикат по тем же таблицам однажды
 * разошёлся бы с первым. Ответ — «да» или «нет», потому что вызывающий решает сам, ждать ему
 * или завершаться; отказ в доступе здесь ожидаемое состояние, а не ошибка.
 */
import type { PoolClient } from "pg";

import { isAppError } from "../app-error.js";
import { readFamilySpaceMode } from "./family-space-mode.js";
import { resolveSpaceAccess } from "./space-access.js";

export interface SpaceDestination {
  readonly familyId: string;
  readonly groupId: string | null;
  readonly spaceId: string | null;
  /** Автор строки для личного чата и для членства в общей области; внешней группе не нужен. */
  readonly userId: string | null;
}

export async function isSpaceDestinationProven(
  client: PoolClient,
  destination: SpaceDestination,
): Promise<boolean> {
  if (await readFamilySpaceMode(client, destination.familyId) !== "spaces") return true;
  // После включения строка без области непроверяема: доставить её значит угадать аудиторию.
  if (destination.spaceId === null) return false;
  try {
    await resolveSpaceAccess(client, {
      chat: destination.groupId === null
        ? { type: "private" }
        : { groupId: destination.groupId, type: "supergroup" },
      familyId: destination.familyId,
      spaceId: destination.spaceId,
      userId: destination.userId,
    });
    return true;
  } catch (error) {
    if (isAppError(error) && error.code === "AGENT_SPACE_ACCESS_DENIED") return false;
    throw error;
  }
}
