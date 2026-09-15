/**
 * Активная область личного чата.
 *
 * Экспорт:
 * - `OwnSpace`: область человека, её читатели и признак активной.
 * - `listOwnSpaces`: области, в которых человек состоит прямо сейчас.
 * - `readActiveSpace`: выбранная область личного чата либо `null`.
 * - `setActiveSpace`: смена выбора с проверкой членства.
 * - `boundChatSpace`: область группового чата вместе с её читателями.
 *
 * Читать в личном чате человек может все свои области сразу: его аудитория это он сам. Но новая
 * запись обязана попасть ровно в одну, и догадываться по содержанию, куда её отнести, нельзя —
 * поэтому активная область выбирается явно и хранится в базе, а не выводится из разговора.
 *
 * Групповой чат здесь ни при чём: его область задаёт привязка, и выбирать в нём нечего.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";

export interface OwnSpace {
  readonly active: boolean;
  readonly kind: string;
  /** Кто читает эту область прямо сейчас: главный вопрос человека о своей записи. */
  readonly readers: string[];
  readonly spaceId: string;
  readonly title: string;
}

/** Область группы сюда не попадает: в личном чате она недоступна по самой модели доступа. */
const OWN_SPACES = `SELECT space.id, space.kind, space.title
     FROM spaces AS space
     JOIN space_memberships AS member
       ON member.family_id = space.family_id AND member.space_id = space.id
      WHERE space.family_id = $1 AND space.state = 'active' AND space.kind <> 'group'
        AND member.user_id = $2 AND member.state = 'active'`;

export async function listOwnSpaces(
  client: PoolClient,
  familyId: string,
  userId: string,
): Promise<OwnSpace[]> {
  // Читатели перечисляются по самой области: «кто это увидит» не выводится из типа чата.
  const rows = await client.query<{ id: string; kind: string; readers: string[]; title: string }>(
    `SELECT own.id, own.kind, own.title,
        ARRAY(
          SELECT users.display_name FROM space_memberships AS reader
            JOIN users ON users.id = reader.user_id
            JOIN family_memberships AS still
              ON still.family_id = reader.family_id AND still.user_id = reader.user_id
           WHERE reader.family_id = own.family_id AND reader.space_id = own.id
             AND reader.state = 'active'
           ORDER BY users.display_name
        ) AS readers
       FROM (${OWN_SPACES}) AS own
      ORDER BY own.kind = 'personal' DESC, own.title, own.id`
      .replace("space.id, space.kind, space.title", "space.id, space.kind, space.title, space.family_id"),
    [familyId, userId],
  );
  const active = await readActiveSpace(client, familyId, userId);
  return rows.rows.map((row) => ({
    active: row.id === active,
    kind: row.kind,
    readers: row.readers,
    spaceId: row.id,
    title: row.title,
  }));
}

/**
 * Выбор проверяется при каждом чтении: область могли архивировать, а членство — отозвать между
 * тем ходом, где человек её выбрал, и этим. Недействительный выбор молча возвращает к личной.
 */
export async function readActiveSpace(
  client: PoolClient,
  familyId: string,
  userId: string,
): Promise<string | null> {
  const chosen = await client.query<{ id: string }>(
    `SELECT space.id FROM private_chat_active_spaces AS choice
       JOIN spaces AS space ON space.id = choice.space_id AND space.family_id = choice.family_id
       JOIN space_memberships AS member
         ON member.family_id = space.family_id AND member.space_id = space.id
        AND member.user_id = choice.user_id AND member.state = 'active'
      WHERE choice.family_id = $1 AND choice.user_id = $2
        AND space.state = 'active' AND space.kind <> 'group'`,
    [familyId, userId],
  );
  return chosen.rows[0]?.id ?? null;
}

export async function setActiveSpace(
  client: PoolClient,
  input: { familyId: string; spaceId: string; userId: string },
): Promise<OwnSpace> {
  const allowed = await client.query<{ id: string; kind: string; title: string }>(
    `${OWN_SPACES} AND space.id = $3 FOR SHARE OF space`,
    [input.familyId, input.userId, input.spaceId],
  );
  const space = allowed.rows[0];
  // Отказ одинаков для «нет такой области» и «я в ней не состою»: иначе выбор подтверждает,
  // что чужая область существует.
  if (!space) {
    throw new AppError("AGENT_SPACE_NOT_AVAILABLE", "Такая область недоступна в вашем личном чате");
  }
  await client.query(
    `INSERT INTO private_chat_active_spaces (family_id, user_id, space_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (family_id, user_id) DO UPDATE SET space_id = EXCLUDED.space_id, changed_at = now()`,
    [input.familyId, input.userId, input.spaceId],
  );
  await client.query(
    `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id)
     VALUES ($1, $2, 'space.active_changed', $3)`,
    [input.familyId, input.userId, input.spaceId],
  );
  return { active: true, kind: space.kind, readers: [], spaceId: space.id, title: space.title };
}

/**
 * У группового чата область не выбирают: её задаёт привязка. Читатели перечисляются по самой
 * области, поэтому ответ «кто это увидит» не зависит ни от типа чата, ни от родства.
 */
export async function boundChatSpace(
  client: PoolClient,
  familyId: string,
  groupId: string,
): Promise<OwnSpace | null> {
  const row = (await client.query<{ id: string; kind: string; readers: string[]; title: string }>(
    `SELECT space.id, space.kind, space.title,
        ARRAY(
          SELECT users.display_name FROM space_memberships AS reader
            JOIN users ON users.id = reader.user_id
            JOIN family_memberships AS still
              ON still.family_id = reader.family_id AND still.user_id = reader.user_id
           WHERE reader.family_id = space.family_id AND reader.space_id = space.id
             AND reader.state = 'active'
           ORDER BY users.display_name
        ) AS readers
       FROM space_bindings AS binding
       JOIN spaces AS space ON space.id = binding.space_id AND space.family_id = binding.family_id
      WHERE binding.family_id = $1 AND binding.group_id = $2 AND binding.state = 'active'
        AND space.state = 'active'`,
    [familyId, groupId],
  )).rows[0];
  return row === undefined ? null : {
    active: true, kind: row.kind, readers: row.readers, spaceId: row.id, title: row.title,
  };
}
