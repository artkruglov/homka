/**
 * Общая фикстура двух закрытых областей одной семьи.
 *
 * Экспорт:
 * - `TwoSpaceFixture`: семья, двое взрослых, две области `shared` и привязанная к одной из них группа.
 * - `createTwoSpaceFixture`: создаёт конфигурацию в тестовой базе.
 * - `currentSpacePolicyVersion`: текущая версия политики области.
 * - `twoSpaceMemoryAuthorization`: объект авторизации памяти для выбранной области и чата.
 * - `bindGroupToSpace`: привязка чата к общей области через подтверждение её состава.
 *
 * Именно эта конфигурация ломает любой предикат, написанный по `scope='family'`: у обеих областей
 * вид записей один и тот же и `scope_partition_key` совпадает с семьёй, поэтому отличить их можно
 * только по `space_id`. Пара «личное плюс семейное» этого не ловит.
 */
import type { PoolClient } from "pg";

import { database } from "../database.js";
import type { MemoryAuthorization } from "../memory-context.js";

export interface TwoSpaceFixtureMember {
  readonly telegramUserId: string;
  readonly userId: string;
}

export interface TwoSpaceFixture {
  readonly familyId: string;
  /** Владелец установки: состоит в обеих областях. */
  readonly owner: TwoSpaceFixtureMember;
  /** Второй взрослый: состоит только в области пары. */
  readonly spouse: TwoSpaceFixtureMember;
  /** Область пары, к ней привязана семейная группа. */
  readonly pairSpaceId: string;
  /** Вторая общая область без привязки к чату. */
  readonly householdSpaceId: string;
  readonly groupId: string;
  readonly telegramChatId: string;
}

/**
 * Привязка общей области всегда начинается неподтверждённой: аудиторию чата доказывают заново,
 * и схема не принимает сразу активную строку. Тесты повторяют тот же порядок, что и Э9.
 */
export async function bindGroupToSpace(
  client: Pick<PoolClient, "query">,
  familyId: string,
  groupId: string,
  spaceId: string,
): Promise<void> {
  await client.query(
    "INSERT INTO space_bindings(family_id,group_id,space_id,state) VALUES($1,$2,$3,'pending_verification')",
    [familyId, groupId, spaceId],
  );
  await client.query("UPDATE space_bindings SET state='active' WHERE group_id=$1", [groupId]);
}

async function insertMember(
  client: PoolClient,
  familyId: string,
  telegramUserId: string,
  displayName: string,
  role: "owner" | "member",
): Promise<TwoSpaceFixtureMember> {
  const user = await client.query<{ id: string }>(
    "INSERT INTO users(telegram_user_id,display_name) VALUES($1,$2) RETURNING id",
    [telegramUserId, displayName],
  );
  await client.query(
    "INSERT INTO family_memberships(family_id,user_id,role) VALUES($1,$2,$3)",
    [familyId, user.rows[0]!.id, role],
  );
  return { telegramUserId, userId: user.rows[0]!.id };
}

async function insertSharedSpace(
  client: PoolClient,
  familyId: string,
  title: string,
  members: readonly string[],
  managerId?: string,
): Promise<string> {
  const space = await client.query<{ id: string }>(
    "INSERT INTO spaces(family_id,kind,title) VALUES($1,'shared',$2) RETURNING id",
    [familyId, title],
  );
  const spaceId = space.rows[0]!.id;
  for (const userId of members) {
    await client.query(
      "INSERT INTO space_memberships(family_id,space_id,user_id,role,state) VALUES($1,$2,$3,$4,'active')",
      [familyId, spaceId, userId, userId === managerId ? "manager" : "adult"],
    );
  }
  // Активация требует, чтобы все членства уже были активны, поэтому она идёт последней.
  await client.query("UPDATE spaces SET state='active' WHERE id=$1", [spaceId]);
  return spaceId;
}

export async function createTwoSpaceFixture(prefix = "two-space", options: { ownerManagesSpaces?: boolean } = {}): Promise<TwoSpaceFixture> {
  const client = await database().connect();
  try {
    const family = await client.query<{ id: string }>(
      "INSERT INTO families(name) VALUES($1) RETURNING id",
      [`${prefix} family`],
    );
    const familyId = family.rows[0]!.id;
    const owner = await insertMember(client, familyId, `${prefix}-owner`, "Владелец", "owner");
    const spouse = await insertMember(client, familyId, `${prefix}-spouse`, "Супруга", "member");
    const group = await client.query<{ id: string }>(
      `INSERT INTO telegram_groups(family_id,telegram_chat_id,title,type,message_mode)
       VALUES($1,$2,'Пара','family_private','addressed_only') RETURNING id`,
      [familyId, `-${Math.abs(hash(prefix))}`],
    );
    const managerId = options.ownerManagesSpaces ? owner.userId : undefined;
    const pairSpaceId = await insertSharedSpace(client, familyId, "Пара", [owner.userId, spouse.userId], managerId);
    const householdSpaceId = await insertSharedSpace(client, familyId, "Хозяйство", [owner.userId], managerId);
    await bindGroupToSpace(client, familyId, group.rows[0]!.id, pairSpaceId);
    const chat = await client.query<{ telegram_chat_id: string }>(
      "SELECT telegram_chat_id FROM telegram_groups WHERE id=$1",
      [group.rows[0]!.id],
    );
    return {
      familyId,
      groupId: group.rows[0]!.id,
      householdSpaceId,
      owner,
      pairSpaceId,
      spouse,
      telegramChatId: chat.rows[0]!.telegram_chat_id,
    };
  } finally {
    client.release();
  }
}

function hash(value: string): number {
  let result = 0;
  for (const character of value) result = (result * 31 + character.codePointAt(0)!) % 1_000_000_007;
  return result % 900_000_000 + 1_000_000;
}

export async function currentSpacePolicyVersion(spaceId: string): Promise<number> {
  const result = await database().query<{ policy_version: number }>(
    "SELECT policy_version FROM spaces WHERE id=$1",
    [spaceId],
  );
  const version = result.rows[0]?.policy_version;
  if (version === undefined) throw new Error("AGENT_TEST_SPACE_MISSING");
  return version;
}

export async function twoSpaceMemoryAuthorization(input: {
  as: TwoSpaceFixtureMember;
  chat: "group" | "private";
  fixture: TwoSpaceFixture;
  spaceId: string;
}): Promise<MemoryAuthorization> {
  return {
    familyId: input.fixture.familyId,
    groupId: input.chat === "group" ? input.fixture.groupId : null,
    role: "member",
    scopes: input.chat === "group" ? ["family"] : ["personal", "family"],
    space: { policyVersion: await currentSpacePolicyVersion(input.spaceId), spaceId: input.spaceId },
    telegramActorId: input.as.telegramUserId,
    telegramActorKind: "telegram_user",
    telegramUserId: input.as.telegramUserId,
    userId: input.as.userId,
  };
}
