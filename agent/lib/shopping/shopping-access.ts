/**
 * Кто видит список покупок и как он выглядит в ответе.
 *
 * Экспорт:
 * - `ShoppingRow`, `presentShoppingItem`: строка списка и её проекция.
 * - `authorizeShopping`: доверенный чат и живое членство в семье.
 * - `shoppingVisibility`: оговорка видимости для запросов списка.
 *
 * Список покупок общий по своей природе: его ведут вдвоём и смотрят в магазине с телефона, то есть
 * из личного чата. Поэтому у пункта нет исполнителя, а аудиторию задаёт область: в групповом чате
 * видна привязанная к нему, в личном — все области самого человека.
 *
 * Пока режим семьи прежний, области нет ни у строки, ни у хода, и оговорка выключается сама: тогда
 * список виден любому участнику семьи, как и было до разделения областей.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { spaceReadClause } from "../spaces/space-sql.js";

export interface ShoppingRow {
  added_by: string;
  bought_at: Date | null;
  bought_by: string | null;
  id: string;
  list_name: string;
  note: string | null;
  quantity: string | null;
  title: string;
  version: number;
  space_id: string | null;
  source: string;
}

export function shoppingDenied(): never {
  throw new AppError("AGENT_SHOPPING_ACCESS_DENIED", "Список покупок недоступен в текущем чате");
}

/** Внешняя группа списков покупок не ведёт: её участники не состоят в семье. */
export async function authorizeShopping(
  client: PoolClient,
  auth: MemoryAuthorization,
): Promise<void> {
  if (auth.telegramActorKind !== "telegram_user" || !auth.telegramUserId || !auth.userId ||
    auth.telegramActorId !== auth.telegramUserId || auth.role === "external") shoppingDenied();
  if (auth.groupId) {
    const group = await client.query(
      "SELECT 1 FROM telegram_groups WHERE id=$1 AND family_id=$2 AND type='family_private' FOR SHARE",
      [auth.groupId, auth.familyId],
    );
    if (!group.rowCount) shoppingDenied();
  }
  const member = await client.query(
    `SELECT 1 FROM family_memberships m JOIN users u ON u.id=m.user_id
      WHERE m.family_id=$1 AND m.user_id=$2 AND u.telegram_user_id=$3 FOR SHARE OF m,u`,
    [auth.familyId, auth.userId, auth.telegramUserId],
  );
  if (!member.rowCount) shoppingDenied();
}

/** Позиции: $1 семья, $2 область, $3 версия политики, $4 человек, $5 группа. */
export const SHOPPING_VISIBILITY = `item.family_id=$1 AND ${spaceReadClause({
  alias: "item",
  parameters: { family: "$1", group: "$5", spaceId: "$2", user: "$4", version: "$3" },
})}`;

export function shoppingVisibilityValues(
  auth: MemoryAuthorization,
): [string, string | null, number | null, string | null, string | null] {
  const space = auth.space;
  return [auth.familyId, space?.spaceId ?? null, space?.policyVersion ?? null,
    auth.userId, auth.groupId];
}

export function presentShoppingItem(row: ShoppingRow) {
  return {
    addedBy: row.added_by,
    boughtAt: row.bought_at?.toISOString() ?? null,
    boughtBy: row.bought_by,
    id: row.id,
    listName: row.list_name,
    note: row.note,
    quantity: row.quantity,
    title: row.title,
    version: row.version,
    spaceId: row.space_id,
    source: row.source,
  };
}
