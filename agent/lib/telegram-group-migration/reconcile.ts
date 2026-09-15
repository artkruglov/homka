/** Operator reconciliation with writers paused; never a model-facing tool.
 * Reads the authority from durable verified ingress, owns one transaction, and refuses in-flight
 * delivery. Runtime draining/late delivery recovery must use the same boundary when connected.
 */
import { INGRESS_SOURCE_CHAT_SQL } from "./retire-ingress.js";
import { retireMigratedGroupReviews } from "./retire-reviews.js";
import { database } from "../database.js";
import { AppError } from "../app-error.js";
import { lockTelegramGroupJournal } from "../telegram-group-message-storage.js";
import { parseGroupMigrationServiceMessage } from "./service-message.js";

function fail(suffix: string, message: string): never {
  throw new AppError(`AGENT_TELEGRAM_GROUP_MIGRATION_${suffix}`, message);
}

export async function reconcileVerifiedGroupMigration(updateId: string) {
  if (!/^\d+$/.test(updateId)) fail("INVALID", "Некорректный номер события переноса");
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const source = await client.query<{ payload: unknown }>(
      "SELECT payload FROM telegram_ingress_updates WHERE update_id=$1", [updateId],
    );
    const event = parseGroupMigrationServiceMessage(source.rows[0]?.payload);
    if (!event || event.updateId !== updateId) fail("SOURCE_MISSING", "Нет проверенного события переноса");
    for (const chatId of [event.oldChatId, event.newChatId].sort()) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`group-migration:${chatId}`]);
    }
    const prior = await client.query<{ group_id: string | null; new_chat_id: string }>(
      "SELECT group_id,new_chat_id FROM telegram_group_migrations WHERE old_chat_id=$1", [event.oldChatId],
    );
    if (prior.rows[0]) {
      if (!prior.rows[0].group_id) fail("GROUP_MISSING", "Прежняя регистрация группы удалена");
      if (prior.rows[0].new_chat_id !== event.newChatId) fail("CONFLICT", "События переноса противоречат друг другу");
      await client.query("COMMIT");
      return { groupId: prior.rows[0].group_id, replayed: true };
    }
    const groups = await client.query<{ id: string; family_id: string; telegram_chat_id: string }>(
      "SELECT id,family_id,telegram_chat_id FROM telegram_groups WHERE telegram_chat_id=ANY($1::text[]) ORDER BY id FOR UPDATE",
      [[event.oldChatId,event.newChatId]],
    );
    if (groups.rows.some(row => row.telegram_chat_id === event.newChatId)) fail("CONFLICT", "Новый адрес уже зарегистрирован");
    const group = groups.rows.find(row => row.telegram_chat_id === event.oldChatId);
    if (!group) fail("GROUP_MISSING", "Исходная группа не зарегистрирована");
    await lockTelegramGroupJournal(client, group.id);
    const active = await client.query<{ busy: boolean }>(`SELECT
      EXISTS(SELECT 1 FROM telegram_ingress_updates item WHERE item.status='processing' AND ${INGRESS_SOURCE_CHAT_SQL}=$2) OR
      EXISTS(SELECT 1 FROM conversation_sessions WHERE group_id=$1 AND retired_at IS NULL AND task_state='running') OR
      EXISTS(SELECT 1 FROM reminders WHERE group_id=$1 AND status='leased') OR
      EXISTS(SELECT 1 FROM agent_schedules WHERE group_id=$1 AND status='leased') OR
      EXISTS(SELECT 1 FROM workspace_file_deliveries WHERE telegram_chat_id=$2 AND status='started') OR
      EXISTS(SELECT 1 FROM video_generation_operations WHERE completion_origin#>>'{target,chatId}'=$2 AND delivery_state='pending'
        AND (status='started' OR completion_lease_until>now())) AS busy`,
      [group.id,event.oldChatId]);
    if (active.rows[0]?.busy) fail("BUSY", "Дождитесь завершения активных действий и доставок");

    await retireMigratedGroupReviews(client, group.id);
    await client.query(`DELETE FROM telegram_hitl_approvals a USING conversation_sessions s
      WHERE a.application_session_id=s.id AND s.group_id=$1`, [group.id]);
    await client.query(`DELETE FROM conversation_session_routes r USING conversation_sessions s
      WHERE r.session_id=s.id AND s.group_id=$1`, [group.id]);
    await client.query(`UPDATE conversation_sessions SET retired_at=now(),delete_after=now()+interval '1 day',
      pending_operation=false,group_timeline_cursor=NULL,
      task_state=CASE WHEN kind<>'canonical' AND task_state='pending' THEN 'failed'::conversation_task_state ELSE task_state END
      WHERE group_id=$1 AND retired_at IS NULL`, [group.id]);
    await client.query("DELETE FROM telegram_chat_audience_proofs WHERE group_id=$1", [group.id]);
    await client.query("UPDATE space_bindings SET state='pending_verification' WHERE group_id=$1", [group.id]);
    await client.query("DELETE FROM telegram_chat_reaction_policies WHERE telegram_chat_id=ANY($1::text[])",
      [[event.oldChatId,event.newChatId]]);
    // Keep history/receipts and scope unchanged. Future jobs require reactivation after audience proof.
    for (const table of ["reminders", "agent_schedules"] as const) {
      await client.query(`UPDATE ${table} SET telegram_chat_id=$2,
        ${table === "agent_schedules" ? "telegram_chat_type='supergroup'," : ""}
        last_error_code=CASE WHEN status='active' THEN 'AGENT_TELEGRAM_GROUP_MIGRATED' ELSE last_error_code END,
        status=CASE WHEN status='active' THEN 'paused' ELSE status END,
        message_thread_id=NULL,forum_topic_id=NULL WHERE group_id=$1 AND telegram_chat_id=$3 AND status IN ('active','paused')`,
      [group.id,event.newChatId,event.oldChatId]);
    }
    await client.query("DELETE FROM oauth_authorizations WHERE telegram_chat_id=$1 AND status='pending'", [event.oldChatId]);
    await client.query("UPDATE application_conversations SET telegram_chat_id=$2 WHERE telegram_group_id=$1", [group.id,event.newChatId]);
    await client.query("UPDATE telegram_groups SET telegram_chat_id=$2 WHERE id=$1", [group.id,event.newChatId]);
    await client.query(`INSERT INTO telegram_group_migrations(family_id,group_id,old_chat_id,new_chat_id,source_update_id)
      VALUES($1,$2,$3,$4,$5)`, [group.family_id,group.id,event.oldChatId,event.newChatId,updateId]);
    await client.query(`INSERT INTO audit_events(family_id,event_type,subject_id,metadata)
      VALUES($1,'telegram.group_migrated',$2,jsonb_build_object('sourceUpdateId',$3::text,'oldChatId',$4::text,'newChatId',$5::text))`,
      [group.family_id,group.id,updateId,event.oldChatId,event.newChatId]);
    await client.query("COMMIT");
    return { groupId: group.id, replayed: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
