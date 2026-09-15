/**
 * Переключение семьи на режим пространств и его откат.
 *
 * Экспорт:
 * - `SpacesCutoverReport`: что именно закрыл переход.
 * - `performSpacesCutover`: одна транзакция перехода.
 * - `revertSpacesCutover`: возврат к прежнему режиму, пока он ещё безопасен.
 *
 * Переход выполняется скриптом, а не инструментом модели: это операция над всей установкой, у
 * неё нет автора-собеседника и нет обратного хода в диалоге.
 *
 * Прежняя сессия несёт историю, доказанную другой аудиторией, поэтому переход отставляет их все и
 * гасит висящие подтверждения: возобновить припаркованный ход после смены правил чтения значит
 * продолжить его под правилами, которых на момент вопроса не было. Ворота самого перехода живут в
 * триггере `guard_family_space_mode`, и обойти их скриптом нельзя.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";

const SESSION_RETENTION_DAYS = 30;

export interface SpacesCutoverReport {
  readonly approvalsCleared: number;
  readonly familyId: string;
  readonly mode: "legacy" | "spaces";
  readonly sessionsRetired: number;
}

interface CutoverInput {
  readonly changedBy: string | null;
  readonly familyId: string;
  readonly now: Date;
  readonly reason: string;
}

async function closeLiveConversations(
  client: PoolClient,
  input: CutoverInput,
): Promise<{ approvalsCleared: number; sessionsRetired: number }> {
  const approvals = await client.query(
    `DELETE FROM telegram_hitl_approvals AS approval
      USING conversation_sessions AS session
      WHERE session.id = approval.application_session_id AND session.family_id = $1`,
    [input.familyId],
  );
  const sessions = await client.query<{ id: string }>(
    `UPDATE conversation_sessions
        SET retired_at = $2, delete_after = $3, pending_operation = false
      WHERE family_id = $1 AND retired_at IS NULL
      RETURNING id`,
    [input.familyId, input.now,
      new Date(input.now.getTime() + SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000)],
  );
  // Прежние якоря Telegram не должны подмешивать старые summaries и результаты инструментов в
  // новый контекст: маршруты уходят вместе с сессиями.
  await client.query(
    `DELETE FROM conversation_session_routes AS route
      USING conversation_sessions AS session
      WHERE session.id = route.session_id AND session.family_id = $1 AND session.retired_at IS NOT NULL`,
    [input.familyId],
  );
  // Карточки содержат уже собранный контекст прежней аудитории. Удаляем только производные
  // представления: исходные conversation, claims и evidence остаются на месте.
  await client.query("DELETE FROM profile_views WHERE family_id=$1", [input.familyId]);
  for (const table of ["memory_context_exposures", "profile_author_exposures"]) {
    await client.query(
      `DELETE FROM ${table} AS exposure USING conversation_sessions AS session
        WHERE exposure.application_session_id=session.id AND session.family_id=$1`,
      [input.familyId],
    );
  }
  return { approvalsCleared: approvals.rowCount ?? 0, sessionsRetired: sessions.rowCount ?? 0 };
}

async function switchMode(
  client: PoolClient,
  input: CutoverInput,
  mode: "legacy" | "spaces",
): Promise<void> {
  const current = await client.query<{ mode: string }>(
    "SELECT mode FROM family_space_runtime WHERE family_id = $1 FOR UPDATE",
    [input.familyId],
  );
  if (!current.rows[0]) {
    throw new AppError("AGENT_SPACE_CUTOVER_FAMILY_UNKNOWN", "Семья не найдена");
  }
  if (current.rows[0].mode === mode) {
    throw new AppError("AGENT_SPACE_CUTOVER_NOT_NEEDED", `Семья уже в режиме ${mode}`);
  }
  await client.query(
    `UPDATE family_space_runtime
        SET mode = $2, reason = $3, changed_by = $4,
            cutover_at = CASE WHEN $2 = 'spaces' THEN $5::timestamptz ELSE NULL END
      WHERE family_id = $1`,
    [input.familyId, mode, input.reason, input.changedBy, input.now],
  );
  await client.query(
    `INSERT INTO audit_events (family_id, actor_user_id, event_type, metadata)
     VALUES ($1, $2, 'space.mode_changed', jsonb_build_object('mode', $3::text))`,
    [input.familyId, input.changedBy, mode],
  );
}

export async function performSpacesCutover(
  client: PoolClient,
  input: CutoverInput,
): Promise<SpacesCutoverReport> {
  const closed = await prepareSpacesCutover(client, input);
  await switchMode(client, input, "spaces");
  return { ...closed, familyId: input.familyId, mode: "spaces" };
}

/** Operator-only preparation, in the caller's transaction and with writers paused.
 * Also used on the isolated rehearsal copy before auditing unresolved legacy records.
 * Repeating it in legacy mode is safe; it does not fabricate audience proofs or switch mode.
 */
export async function prepareSpacesCutover(client: PoolClient, input: CutoverInput) {
  const current = await client.query<{ mode: string }>(
    "SELECT mode FROM family_space_runtime WHERE family_id=$1 FOR UPDATE", [input.familyId],
  );
  if (!current.rows[0]) throw new AppError("AGENT_SPACE_CUTOVER_FAMILY_UNKNOWN", "Семья не найдена");
  if (current.rows[0].mode !== "legacy") {
    throw new AppError("AGENT_SPACE_CUTOVER_NOT_NEEDED", "Семья уже в режиме spaces");
  }
  const closed = await closeLiveConversations(client, input);
  let operationalRowsQuarantined = 0;
  for (const table of ["audit_events", "agent_improvement_items"]) {
    const result = await client.query(
      `UPDATE ${table} SET legacy_quarantined_at=$2
        WHERE family_id=$1 AND legacy_quarantined_at IS NULL`, [input.familyId, input.now],
    );
    operationalRowsQuarantined += result.rowCount ?? 0;
  }
  return { ...closed, operationalRowsQuarantined };
}

/**
 * Содержимое, которое написали люди и у которого есть аудитория. Дочерние строки — доказательства,
 * записи нити, журналы операций — сюда не входят: их область приходит от родителя, и родитель уже
 * в списке. Новая таблица с собственной областью и авторским содержимым обязана попасть сюда:
 * иначе откат тихо расширил бы её аудиторию. Это проверяет тест, а не память.
 */
export const ROLLBACK_CONTENT_TABLES: Readonly<Record<string, string>> = {
  agent_schedules: "created_at",
  care_areas: "created_at",
  chat_message_relays: "created_at",
  memory_items: "created_at",
  // У доставки нет created_at: она существует ровно в момент отправки.
  proactive_deliveries: "delivered_at",
  reminders: "created_at",
  shared_tasks: "created_at",
  shopping_items: "created_at",
};

/**
 * Откат режима безопасен ровно до первой записи, сделанной уже в новой области: прежние читатели
 * разбирают такие строки предикатами по разделу, и запись пары стала бы общесемейной. Поэтому
 * скрипт сам проверяет данные, а не полагается на память оператора.
 */
export async function revertSpacesCutover(
  client: PoolClient,
  input: CutoverInput,
): Promise<SpacesCutoverReport> {
  const runtime = await client.query<{ cutover_at: Date | null }>(
    "SELECT cutover_at FROM family_space_runtime WHERE family_id = $1 FOR UPDATE",
    [input.familyId],
  );
  const cutoverAt = runtime.rows[0]?.cutover_at ?? null;
  if (cutoverAt !== null) {
    const written = await client.query<{ relation: string }>(
      Object.entries(ROLLBACK_CONTENT_TABLES)
        .map(([table, since]) => `SELECT '${table}' AS relation FROM ${table} row_
         JOIN spaces space ON space.id = row_.space_id
        WHERE row_.family_id = $1 AND space.legacy_scope IS NULL AND row_.${since} >= $2`)
        .join("\n UNION ALL\n"),
      [input.familyId, cutoverAt],
    );
    if (written.rowCount) {
      const relations = [...new Set(written.rows.map((row) => row.relation))].sort();
      throw new AppError(
        "AGENT_SPACE_ROLLBACK_UNSAFE",
        `После перехода появились записи в новых областях (${relations.join(", ")}): откат режима расширил бы их аудиторию`,
      );
    }
  }
  const closed = await closeLiveConversations(client, input);
  await switchMode(client, input, "legacy");
  return { ...closed, familyId: input.familyId, mode: "legacy" };
}
