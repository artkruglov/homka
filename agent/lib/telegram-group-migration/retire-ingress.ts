/** Finish pending updates from a verified retired transport before leasing them to paid work.
 * Payloads and update-id deduplication receipts remain intact; processing leases are never stolen.
 */
import { database } from "../database.js";

export const INGRESS_SOURCE_CHAT_SQL = `COALESCE(
        item.payload#>>'{message,chat,id}', item.payload#>>'{edited_message,chat,id}',
        item.payload#>>'{channel_post,chat,id}', item.payload#>>'{edited_channel_post,chat,id}',
        item.payload#>>'{callback_query,message,chat,id}')`;

// Authored SQL only, always applied to the ingress table aliased as item.
export const RETIRED_INGRESS_CHAT_SQL = `EXISTS (
      SELECT 1 FROM telegram_group_migrations migration
      WHERE migration.old_chat_id = ${INGRESS_SOURCE_CHAT_SQL}
    )`;

export async function retireMigratedChatIngress(): Promise<void> {
  await database().query(`WITH retired AS (
    SELECT item.update_id FROM telegram_ingress_updates item
    WHERE item.status='pending' AND ${RETIRED_INGRESS_CHAT_SQL}
    FOR UPDATE OF item SKIP LOCKED
  ) UPDATE telegram_ingress_updates item
    SET status=CASE WHEN dispatch_started_at IS NULL AND voice_transcription_started_at IS NULL
          THEN 'completed' ELSE 'failed' END,
        completed_at=now(),updated_at=now(),
        last_error_code='AGENT_TELEGRAM_GROUP_ADDRESS_RETIRED',
        last_error_message='Чат перенесён в супергруппу. Сообщение старого чата не выполнялось повторно.'
    FROM retired WHERE item.update_id=retired.update_id AND item.status='pending'`);
}
