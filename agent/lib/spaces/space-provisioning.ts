/**
 * Выдача пространств при появлении семьи, участника и группы.
 *
 * Экспорт:
 * - `provisionFamilySpaces`: семейная область и личное пространство владельца.
 * - `provisionMemberPersonalSpace`: личное пространство нового участника.
 * - `provisionGroupSpace`: область группы и её привязка к чату.
 *
 * Снимок миграции 103 выдаёт пространства только тем, кто существовал на момент переноса. Всё, что
 * появляется позже, обязано получать их здесь: иначе после включения режима человек останется без
 * личной области, а группа — без привязки, и обе будут отказаны навсегда.
 *
 * Состав активного пространства заморожен намеренно (`AGENT_SPACE_AUDIENCE_FROZEN`), поэтому нового
 * участника **не** добавляют в прежнюю семейную область: для нового состава создаётся новое
 * пространство и выбранные записи переносятся явной публикацией. Здесь выдаётся только личное.
 */
import type { PoolClient } from "pg";

type PersonalRole = "adult" | "manager";

async function findSpace(
  client: PoolClient,
  familyId: string,
  legacyScope: "family" | "personal" | "group",
  owner: string | null,
  group: string | null,
): Promise<string | null> {
  const found = await client.query<{ id: string }>(
    `SELECT id FROM spaces
      WHERE family_id=$1 AND legacy_scope=$2::memory_scope
        AND owner_user_id IS NOT DISTINCT FROM $3::uuid
        AND source_group_id IS NOT DISTINCT FROM $4::uuid`,
    [familyId, legacyScope, owner, group],
  );
  return found.rows[0]?.id ?? null;
}

async function activate(client: PoolClient, spaceId: string): Promise<void> {
  // Активация требует, чтобы каждое членство уже было активным, поэтому она идёт последней.
  await client.query("UPDATE spaces SET state='active' WHERE id=$1 AND state='forming'", [spaceId]);
}

async function addMember(
  client: PoolClient,
  familyId: string,
  spaceId: string,
  userId: string,
  role: PersonalRole,
): Promise<void> {
  await client.query(
    `INSERT INTO space_memberships(family_id,space_id,user_id,role,state)
     VALUES($1,$2,$3,$4,'active') ON CONFLICT (space_id,user_id) DO NOTHING`,
    [familyId, spaceId, userId, role],
  );
}

async function createPersonalSpace(
  client: PoolClient,
  familyId: string,
  userId: string,
): Promise<string> {
  const existing = await findSpace(client, familyId, "personal", userId, null);
  if (existing) return existing;
  const created = await client.query<{ id: string }>(
    `INSERT INTO spaces(family_id,kind,title,owner_user_id,legacy_scope)
     VALUES($1,'personal','Личное',$2,'personal') RETURNING id`,
    [familyId, userId],
  );
  const spaceId = created.rows[0]!.id;
  await addMember(client, familyId, spaceId, userId, "manager");
  await activate(client, spaceId);
  return spaceId;
}

/** Прежняя семейная область: та, куда ложатся записи вида `family`. */
async function createFamilySpace(
  client: PoolClient,
  familyId: string,
  members: readonly { role: PersonalRole; userId: string }[],
): Promise<string> {
  const existing = await findSpace(client, familyId, "family", null, null);
  if (existing) return existing;
  const created = await client.query<{ id: string }>(
    `INSERT INTO spaces(family_id,kind,title,legacy_scope)
     VALUES($1,'legacy_family','Семья','family') RETURNING id`,
    [familyId],
  );
  const spaceId = created.rows[0]!.id;
  for (const member of members) await addMember(client, familyId, spaceId, member.userId, member.role);
  await activate(client, spaceId);
  return spaceId;
}

export async function provisionFamilySpaces(
  client: PoolClient,
  input: { familyId: string; ownerUserId: string },
): Promise<void> {
  await createFamilySpace(client, input.familyId, [{ role: "manager", userId: input.ownerUserId }]);
  await createPersonalSpace(client, input.familyId, input.ownerUserId);
}

export async function provisionMemberPersonalSpace(
  client: PoolClient,
  input: { familyId: string; userId: string },
): Promise<void> {
  await createPersonalSpace(client, input.familyId, input.userId);
}

export async function provisionGroupSpace(
  client: PoolClient,
  input: { familyId: string; groupId: string; type: "external" | "family_private" },
): Promise<void> {
  const bound = await client.query(
    "SELECT 1 FROM space_bindings WHERE group_id=$1",
    [input.groupId],
  );
  if (bound.rowCount) return;
  if (input.type === "external") {
    const existing = await findSpace(client, input.familyId, "group", null, input.groupId);
    const spaceId = existing ?? (await client.query<{ id: string }>(
      `INSERT INTO spaces(family_id,kind,title,source_group_id,legacy_scope)
       SELECT family_id,'group',left(title,100),id,'group' FROM telegram_groups WHERE id=$1
       RETURNING id`,
      [input.groupId],
    )).rows[0]!.id;
    await activate(client, spaceId);
    await client.query(
      "INSERT INTO space_bindings(family_id,group_id,space_id,state) VALUES($1,$2,$3,'active')",
      [input.familyId, input.groupId, spaceId],
    );
    return;
  }
  // Семейный чат получает привязку к прежней семейной области, но состав его аудитории ещё не
  // доказан: подтверждает его владелец, до того чат остаётся неподтверждённым.
  const members = await client.query<{ role: string; user_id: string }>(
    "SELECT role,user_id FROM family_memberships WHERE family_id=$1",
    [input.familyId],
  );
  const spaceId = await createFamilySpace(
    client,
    input.familyId,
    members.rows.map((row) => ({
      role: row.role === "member" ? "adult" as const : "manager" as const,
      userId: row.user_id,
    })),
  );
  await client.query(
    "INSERT INTO space_bindings(family_id,group_id,space_id,state) VALUES($1,$2,$3,'pending_verification')",
    [input.familyId, input.groupId, spaceId],
  );
}
