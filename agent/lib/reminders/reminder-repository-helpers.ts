/**
 * PostgreSQL reminder authorization and replay helpers.
 *
 * Exports:
 * - `REMINDER_COLUMNS`: shared safe projection.
 * - Membership, timezone, operation, row-lock, and mutation authorization helpers.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { memorySpaceParameters } from "../memory-context.js";
import { spaceReadClause } from "../spaces/space-sql.js";
import type { ReminderAuthorization } from "./reminder-context.js";
import type { ReminderRow } from "./reminder-record.js";

export interface MutableReminderRow extends ReminderRow {
  author_user_id: string;
  family_id: string;
  occurrence_index: number;
  recurrence_anchor_local: Date;
}

export const REMINDER_COLUMNS = `id, scope, content, timezone, due_at, recurrence_unit,
  recurrence_interval, status, message_thread_id::text, forum_topic_id::text,
  last_error_code, created_at, updated_at, shared_task_id, task_reminder_kind`;

/** Оговорка области для строки под псевдонимом `reminder`: $3 человек, $4 область, $5 версия, $6 группа. */
export const REMINDER_SPACE_CLAUSE = spaceReadClause({
  alias: "reminder",
  parameters: { family: "$1", group: "$6", spaceId: "$4", user: "$3", version: "$5" },
});

export async function requireCurrentMembership(
  client: PoolClient,
  auth: ReminderAuthorization,
): Promise<"member" | "owner" | "recovery_owner"> {
  const membership = await client.query<{ role: "member" | "owner" | "recovery_owner" }>(
    "SELECT role FROM family_memberships WHERE family_id = $1 AND user_id = $2",
    [auth.familyId, auth.userId],
  );
  const role = membership.rows[0]?.role;
  if (!role) {
    throw new AppError("AGENT_ACCESS_DENIED", "У вас больше нет доступа к этой семье");
  }
  return role;
}

export async function requireTimezone(client: PoolClient, timezone: string): Promise<string> {
  const result = await client.query<{ name: string }>(
    "SELECT name FROM pg_timezone_names WHERE name = $1",
    [timezone],
  );
  if (!result.rows[0]) {
    throw new AppError(
      "AGENT_TIMEZONE_INVALID",
      "Не удалось распознать часовой пояс. Укажите название IANA, например Europe/Moscow",
    );
  }
  return result.rows[0].name;
}

export async function findReminderOperation(
  client: PoolClient,
  auth: ReminderAuthorization,
  operationKey: string,
  operationKind: "create" | "delete" | "update",
  inputHash: string,
): Promise<string | null | undefined> {
  const result = await client.query<{
    input_hash: string;
    operation_kind: string;
    reminder_id: string | null;
  }>(
    `SELECT operation_kind, input_hash, reminder_id
     FROM reminder_operations WHERE family_id = $1 AND operation_key = $2`,
    [auth.familyId, operationKey],
  );
  const operation = result.rows[0];
  if (!operation) return undefined;
  if (operation.operation_kind !== operationKind || operation.input_hash !== inputHash) {
    throw new AppError(
      "AGENT_REMINDER_OPERATION_CONFLICT",
      "Повтор операции напоминания содержит другие параметры",
    );
  }
  return operation.reminder_id;
}

/**
 * Выборка напоминания по id вместе с его областью. Право изменить проверяется отдельно по автору
 * и роли, но сначала строка обязана быть видимой: владелец семьи не участник каждой её области.
 *
 * Оговорка не прикреплена к активной области намеренно. Область у напоминания это адресат сигнала,
 * а не разрешение: требовать переключения ради переноса семейного напоминания из личного чата
 * значило бы прятать от человека его собственное дело.
 */
export async function selectReminder(
  client: PoolClient,
  auth: Pick<ReminderAuthorization, "familyId" | "groupId" | "space" | "userId">,
  id: string,
  lock = false,
): Promise<MutableReminderRow | null> {
  const result = await client.query<MutableReminderRow>(
    `SELECT ${REMINDER_COLUMNS}, family_id, author_user_id, occurrence_index,
            recurrence_anchor_local
     FROM reminders AS reminder
     WHERE reminder.family_id = $1 AND reminder.id = $2
       AND ${REMINDER_SPACE_CLAUSE}${lock ? " FOR UPDATE" : ""}`,
    [auth.familyId, id, auth.userId, ...memorySpaceParameters(auth), auth.groupId],
  );
  return result.rows[0] ?? null;
}

/**
 * Whether the current chat may see a reminder at all. A personal reminder belongs to its owner's
 * private chat: naming it in the family group would put private text into shared model context,
 * even for the owner asking there. The audience rule precedes every author or role check.
 */
export function reminderVisibleInChat(
  auth: Pick<ReminderAuthorization, "telegramChatType">,
  reminder: { scope: string },
): boolean {
  return reminder.scope !== "personal" || auth.telegramChatType === "private";
}

export async function requireReminderMutationAccess(
  client: PoolClient,
  auth: ReminderAuthorization,
  reminder: MutableReminderRow,
): Promise<void> {
  if (!reminderVisibleInChat(auth, reminder)) {
    throw new AppError("AGENT_REMINDER_NOT_FOUND", "Напоминание не найдено");
  }
  const role = await requireCurrentMembership(client, auth);
  const allowed = reminder.scope === "personal"
    ? reminder.author_user_id === auth.userId
    : reminder.author_user_id === auth.userId || role === "owner";
  if (!allowed) {
    throw new AppError(
      "AGENT_REMINDER_MUTATION_DENIED",
      "Изменить семейное напоминание может только его автор или владелец семьи",
    );
  }
}
