/** Verified family recipients. Model references are opaque; delivery addresses stay backend-only. */
import type { PoolClient } from "pg";
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { authorize, participants } from "../shared-task-access.js";

export async function authorizeErrandActor(client: PoolClient, auth: MemoryAuthorization): Promise<string> {
  if (auth.groupId !== null || !auth.userId || auth.role === "external") {
    throw new AppError("AGENT_ERRAND_PRIVATE_ONLY", "Поручения другому человеку доступны в личном чате");
  }
  await authorize(client, auth);
  return auth.userId;
}

interface RecipientRow {
  id: string;
  display_name: string;
  user_id: string;
  telegram_chat_id: string | null;
}

async function recipientRows(client: PoolClient, auth: MemoryAuthorization, id: string | null) {
  // This upsert is the same stable opaque directory used for shared tasks. Private tasks do not
  // enumerate recipients, but a private errand explicitly does: reuse the family directory.
  await participants(client, auth, "family");
  return (await client.query<RecipientRow>(
    `SELECT p.id,u.display_name,u.id AS user_id,c.telegram_chat_id
       FROM shared_task_participants p
       JOIN users u ON u.telegram_user_id=p.telegram_user_id
       JOIN family_memberships fm ON fm.user_id=u.id AND fm.family_id=p.family_id
       LEFT JOIN application_conversations c ON c.owner_user_id=u.id AND c.family_id=p.family_id
         AND c.scope='personal' AND c.telegram_group_id IS NULL AND c.telegram_chat_id=u.telegram_user_id
      WHERE p.family_id=$1 AND p.group_id IS NULL AND u.id<>$2
        AND ($3::uuid IS NULL OR p.id=$3)
      ORDER BY u.display_name,p.id LIMIT 100`,
    [auth.familyId, auth.userId, id],
  )).rows;
}

/** Caller keeps the transaction through creation; this never accepts a raw Telegram address. */
export async function resolveErrandRecipient(
  client: PoolClient, auth: MemoryAuthorization, recipientRef: string,
): Promise<{ userId: string; name: string; chatId: string | null }> {
  const [row] = await recipientRows(client, auth, recipientRef);
  if (!row) throw new AppError("AGENT_ERRAND_RECIPIENT_UNAVAILABLE", "Получатель больше недоступен. Прочитайте список заново");
  return { userId: row.user_id, name: row.display_name, chatId: row.telegram_chat_id };
}

export async function listErrandRecipients(auth: MemoryAuthorization) {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await authorizeErrandActor(client, auth);
    const rows = await recipientRows(client, auth, null);
    await client.query("COMMIT");
    return rows.map(row => ({ name: row.display_name, recipientRef: row.id }));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
