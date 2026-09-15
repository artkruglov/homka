/**
 * Выбор области хода из проверенного состояния чата.
 *
 * Экспорт:
 * - `TurnSpaceSelection`: вход из уже проверенной авторизации разговора.
 * - `resolveTurnSpaceContext`: область текущего хода либо `null`, если режим семьи ещё прежний.
 * - `resolveTurnSpace`: то же со своим соединением, для вызова из обработчика сообщения.
 * - `resolveTelegramChatMode`: прежний режим, неподтверждённый чат или доказанный.
 *
 * Область выводится из самого чата, а не из колонки, которую заполнил перенос: личный чат работает
 * в личном пространстве своего человека, групповой — в том, к которому привязан чат. Так новый
 * разговор, созданный уже после переноса, получает область наравне с прежними.
 *
 * Ничто здесь не приходит из текста модели: и семья, и человек, и группа берутся из проверенного
 * обновления Telegram и состояния PostgreSQL.
 */
import type { PoolClient } from "pg";

import { database } from "../database.js";
import { readActiveSpace } from "./active-space.js";
import { readFamilySpaceMode } from "./family-space-mode.js";
import type { SpaceContext } from "./space-access.js";

export interface TurnSpaceSelection {
  readonly chatType: "group" | "private" | "supergroup";
  readonly familyId: string;
  readonly groupId: string | null;
  readonly userId: string | null;
}

async function personalSpaceOf(
  client: PoolClient,
  familyId: string,
  userId: string,
): Promise<string | null> {
  const found = await client.query<{ id: string }>(
    `SELECT id FROM spaces
      WHERE family_id=$1 AND kind='personal' AND owner_user_id=$2 AND state='active'`,
    [familyId, userId],
  );
  return found.rows[0]?.id ?? null;
}

async function boundSpaceOf(
  client: PoolClient,
  familyId: string,
  groupId: string,
): Promise<string | null> {
  // Только подтверждённая привязка: чат с неподтверждённым составом области не получает.
  const found = await client.query<{ space_id: string }>(
    `SELECT space_id FROM space_bindings
      WHERE family_id=$1 AND group_id=$2 AND state='active'`,
    [familyId, groupId],
  );
  return found.rows[0]?.space_id ?? null;
}

export async function resolveTurnSpaceContext(
  client: PoolClient,
  input: TurnSpaceSelection,
): Promise<SpaceContext | null> {
  if (await readFamilySpaceMode(client, input.familyId) !== "spaces") return null;
  if (input.chatType === "private") {
    if (input.groupId !== null || input.userId === null) return null;
    // Читает человек все свои области, а пишет в выбранную: без явного выбора это личная.
    const spaceId = await readActiveSpace(client, input.familyId, input.userId)
      ?? await personalSpaceOf(client, input.familyId, input.userId);
    return spaceId === null
      ? null
      : { chat: { type: "private" }, familyId: input.familyId, spaceId, userId: input.userId };
  }
  if (input.groupId === null) return null;
  const spaceId = await boundSpaceOf(client, input.familyId, input.groupId);
  return spaceId === null ? null : {
    chat: { groupId: input.groupId, type: input.chatType },
    familyId: input.familyId,
    spaceId,
    userId: input.userId,
  };
}

/** Подготовка сессии перепроверяет эту область под блокировкой, поэтому устаревший выбор безопасен. */
export async function resolveTurnSpace(input: TurnSpaceSelection): Promise<SpaceContext | null> {
  const client = await database().connect();
  try {
    return await resolveTurnSpaceContext(client, input);
  } finally {
    client.release();
  }
}

export type TelegramChatMode = "legacy" | "proven" | "unproven";

/**
 * Третий режим нужен, чтобы неподтверждённый чат не тратил ход впустую: без него сообщение
 * запускает модель, а ответ приостанавливается уже на доставке — человек всё равно остаётся без
 * ответа, но после нескольких секунд работы и оплаченного вызова.
 *
 * Свежесть доказательства здесь не проверяется намеренно: её обновляет сверка счётчика на старте
 * хода, и требование свежести до начала хода сделало бы молчащий чат недостижимым навсегда.
 */
export async function resolveTelegramChatMode(input: TurnSpaceSelection): Promise<TelegramChatMode> {
  const client = await database().connect();
  try {
    if (await readFamilySpaceMode(client, input.familyId) !== "spaces") return "legacy";
    if (input.chatType === "private") {
      if (input.userId === null) return "unproven";
      return await personalSpaceOf(client, input.familyId, input.userId) === null
        ? "unproven"
        : "proven";
    }
    if (input.groupId === null) return "unproven";
    const spaceId = await boundSpaceOf(client, input.familyId, input.groupId);
    if (spaceId === null) return "unproven";
    const proof = await client.query(
      `SELECT 1 FROM telegram_chat_audience_proofs
        WHERE group_id = $1 AND space_id = $2
          AND space_policy_version = (SELECT policy_version FROM spaces WHERE id = $2)`,
      [input.groupId, spaceId],
    );
    return proof.rowCount === 1 ? "proven" : "unproven";
  } finally {
    client.release();
  }
}
