/** PostgreSQL authorization must isolate a couple even after the family gains members. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";

import { closeDatabase, database } from "../database.js";
import { authorizeSpaceAction, resolveSpaceAccess, type SpaceContext } from "./space-access.js";
import { bindGroupToSpace } from "./two-space-fixture.js";

const dbDescribe = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;
let family: string;
let owner: string;
let spouse: string;
let helper: string;
let pair: string;

async function transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

function personalContext(spaceId = pair, userId = owner): SpaceContext {
  return { familyId: family, userId, spaceId, chat: { type: "private" } };
}

async function makeSpace(input: { kind?: string; ownerId?: string; members: Array<[string, string]> }): Promise<string> {
  return transaction(async (client) => {
    const id = (await client.query<{ id: string }>(
      "INSERT INTO spaces(family_id,kind,title,owner_user_id) VALUES($1,$2,'Test space',$3) RETURNING id",
      [family, input.kind ?? "shared", input.ownerId ?? null],
    )).rows[0]!.id;
    for (const [userId, role] of input.members) {
      await client.query("INSERT INTO space_memberships(family_id,space_id,user_id,role,state) VALUES($1,$2,$3,$4,'active')",
        [family, id, userId, role]);
    }
    await client.query("UPDATE spaces SET state='active' WHERE id=$1", [id]);
    return id;
  });
}

dbDescribe("space access", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE families, users CASCADE");
    family = (await database().query<{ id: string }>("INSERT INTO families(name) VALUES('Test family') RETURNING id")).rows[0]!.id;
    const ids: string[] = [];
    for (const [telegramId, role] of [["101", "owner"], ["102", "member"], ["103", "member"]]) {
      const id = (await database().query<{ id: string }>("INSERT INTO users(telegram_user_id,display_name) VALUES($1,'Person') RETURNING id", [telegramId])).rows[0]!.id;
      await database().query("INSERT INTO family_memberships(family_id,user_id,role) VALUES($1,$2,$3)", [family, id, role]);
      ids.push(id);
    }
    [owner, spouse, helper] = ids as [string, string, string];
    pair = await makeSpace({ members: [[owner, "manager"], [spouse, "adult"]] });
  });
  afterAll(closeDatabase);

  it("allows the two members and does not give a family member access to the couple", async () => {
    expect(await transaction((c) => resolveSpaceAccess(c, personalContext()))).toMatchObject({ spaceId: pair, role: "manager" });
    expect(await transaction((c) => resolveSpaceAccess(c, personalContext(pair, spouse)))).toMatchObject({ role: "adult" });
    await expect(transaction((c) => resolveSpaceAccess(c, personalContext(pair, helper))))
      .rejects.toMatchObject({ code: "AGENT_SPACE_ACCESS_DENIED" });
  });

  it("does not let an installation owner read the spouse's personal or work space", async () => {
    for (const kind of ["personal", "work"]) {
      const id = await makeSpace({ kind, ownerId: spouse, members: [[spouse, "manager"]] });
      await expect(transaction((c) => resolveSpaceAccess(c, personalContext(id))))
        .rejects.toMatchObject({ code: "AGENT_SPACE_ACCESS_DENIED" });
      expect(await transaction((c) => resolveSpaceAccess(c, personalContext(id, spouse)))).toMatchObject({ kind });
    }
  });

  it("rejects an added reader after activation and does not restore a revoked membership", async () => {
    await expect(database().query("INSERT INTO space_memberships(family_id,space_id,user_id,role,state) VALUES($1,$2,$3,'adult','active')", [family, pair, helper]))
      .rejects.toThrow(/AGENT_SPACE_AUDIENCE_FROZEN/);
    await database().query("UPDATE space_memberships SET state='revoked' WHERE space_id=$1 AND user_id=$2", [pair, spouse]);
    await expect(database().query("UPDATE space_memberships SET state='active' WHERE space_id=$1 AND user_id=$2", [pair, spouse]))
      .rejects.toThrow(/AGENT_SPACE_MEMBERSHIP_TERMINAL/);
  });

  it("invalidates an old context when access changes and checks current family membership", async () => {
    const context = personalContext();
    const before = await transaction((c) => resolveSpaceAccess(c, context));
    await database().query("UPDATE space_memberships SET state='revoked' WHERE space_id=$1 AND user_id=$2", [pair, spouse]);
    await expect(transaction((c) => authorizeSpaceAction(c, { ...context, policyVersion: before.policyVersion }, "write")))
      .rejects.toMatchObject({ code: "AGENT_SPACE_CONTEXT_STALE" });
    await expect(transaction((c) => resolveSpaceAccess(c, personalContext(pair, spouse))))
      .rejects.toMatchObject({ code: "AGENT_SPACE_ACCESS_DENIED" });
    await database().query("DELETE FROM family_memberships WHERE family_id=$1 AND user_id=$2", [family, owner]);
    await expect(transaction((c) => resolveSpaceAccess(c, context))).rejects.toMatchObject({ code: "AGENT_SPACE_ACCESS_DENIED" });
  });

  it("requires the exact active group binding even when the sender can read both spaces privately", async () => {
    const groupId = (await database().query<{ id: string }>("INSERT INTO telegram_groups(family_id,telegram_chat_id,title,type,message_mode) VALUES($1,'-101','Test group','family_private','addressed_only') RETURNING id", [family])).rows[0]!.id;
    await database().query("INSERT INTO space_bindings(family_id,group_id,space_id) VALUES($1,$2,$3)", [family, groupId, pair]);
    const context: SpaceContext = { ...personalContext(), chat: { type: "group", groupId } };
    await expect(transaction((c) => resolveSpaceAccess(c, context))).rejects.toMatchObject({ code: "AGENT_SPACE_ACCESS_DENIED" });
    await database().query("UPDATE space_bindings SET state='active' WHERE group_id=$1", [groupId]);
    expect(await transaction((c) => resolveSpaceAccess(c, context))).toMatchObject({ spaceId: pair });
    const another = await makeSpace({ members: [[owner, "manager"]] });
    await expect(transaction((c) => resolveSpaceAccess(c, { ...context, spaceId: another })))
      .rejects.toMatchObject({ code: "AGENT_SPACE_ACCESS_DENIED" });
  });

  it("does not expose missing, cross-family or invited spaces", async () => {
    await expect(transaction((c) => resolveSpaceAccess(c, personalContext("00000000-0000-4000-8000-000000000000"))))
      .rejects.toMatchObject({ code: "AGENT_SPACE_ACCESS_DENIED" });
    await expect(transaction((c) => resolveSpaceAccess(c, { ...personalContext(), familyId: "00000000-0000-4000-8000-000000000000" })))
      .rejects.toMatchObject({ code: "AGENT_SPACE_ACCESS_DENIED" });
    const forming = (await database().query<{ id: string }>("INSERT INTO spaces(family_id,kind,title) VALUES($1,'shared','Not ready') RETURNING id", [family])).rows[0]!.id;
    await database().query("INSERT INTO space_memberships(family_id,space_id,user_id,role) VALUES($1,$2,$3,'adult')", [family, forming, owner]);
    await expect(transaction((c) => resolveSpaceAccess(c, personalContext(forming)))).rejects.toMatchObject({ code: "AGENT_SPACE_ACCESS_DENIED" });
    await expect(database().query("UPDATE spaces SET state='active' WHERE id=$1", [forming])).rejects.toThrow(/AGENT_SPACE_AUDIENCE_NOT_READY/);
  });

  it("keeps helper/child actions limited without turning them into an administrator", async () => {
    for (const role of ["helper", "child"]) {
      const id = await makeSpace({ members: [[owner, "manager"], [helper, role]] });
      const context = personalContext(id, helper);
      const access = await transaction((c) => resolveSpaceAccess(c, context));
      expect(await transaction((c) => authorizeSpaceAction(c, { ...context, policyVersion: access.policyVersion }, "complete_own_task"))).toMatchObject({ role });
      await expect(transaction((c) => authorizeSpaceAction(c, { ...context, policyVersion: access.policyVersion }, "manage_members")))
        .rejects.toMatchObject({ code: "AGENT_SPACE_ACCESS_DENIED" });
      if (role === "child") await expect(transaction((c) => authorizeSpaceAction(c, { ...context, policyVersion: access.policyVersion }, "write")))
        .rejects.toMatchObject({ code: "AGENT_SPACE_ACCESS_DENIED" });
    }
  });

  it("limits an external conversation to its exact group and does not grant private projection", async () => {
    const groupId = (await database().query<{ id: string }>(
      "INSERT INTO telegram_groups(family_id,telegram_chat_id,title,type,message_mode) VALUES($1,'-201','External','external','addressed_only') RETURNING id", [family],
    )).rows[0]!.id;
    const spaceId = (await database().query<{ id: string }>(
      "INSERT INTO spaces(family_id,kind,title,source_group_id) VALUES($1,'group','External',$2) RETURNING id", [family, groupId],
    )).rows[0]!.id;
    await database().query("UPDATE spaces SET state='active' WHERE id=$1", [spaceId]);
    await bindGroupToSpace(database(), family, groupId, spaceId);
    const context: SpaceContext = { familyId: family, userId: null, spaceId, chat: { type: "supergroup", groupId } };
    const access = await transaction((c) => resolveSpaceAccess(c, context));
    expect(access).toMatchObject({ role: "external", spaceId });
    await expect(transaction((c) => authorizeSpaceAction(c, { ...context, policyVersion: access.policyVersion }, "manage_members")))
      .rejects.toMatchObject({ code: "AGENT_SPACE_ACCESS_DENIED" });
    await expect(transaction((c) => resolveSpaceAccess(c, { ...context, spaceId: pair })))
      .rejects.toMatchObject({ code: "AGENT_SPACE_ACCESS_DENIED" });
    await expect(transaction((c) => resolveSpaceAccess(c, personalContext(spaceId))))
      .rejects.toMatchObject({ code: "AGENT_SPACE_ACCESS_DENIED" });
    await expect(database().query("UPDATE space_bindings SET space_id=$1 WHERE group_id=$2", [pair, groupId]))
      .rejects.toThrow(/AGENT_SPACE_BINDING_INVALID/);
  });

  it("requires a paused binding before rebinding and invalidates its former context", async () => {
    const groupId = (await database().query<{ id: string }>(
      "INSERT INTO telegram_groups(family_id,telegram_chat_id,title,type,message_mode) VALUES($1,'-301','Pair','family_private','addressed_only') RETURNING id", [family],
    )).rows[0]!.id;
    await bindGroupToSpace(database(), family, groupId, pair);
    const before = await transaction((c) => resolveSpaceAccess(c, personalContext()));
    const another = await makeSpace({ members: [[owner, "manager"]] });
    await expect(database().query("UPDATE space_bindings SET space_id=$1 WHERE group_id=$2", [another, groupId]))
      .rejects.toThrow(/AGENT_SPACE_BINDING_PAUSE_REQUIRED/);
    await database().query("UPDATE space_bindings SET state='paused' WHERE group_id=$1", [groupId]);
    await database().query("UPDATE space_bindings SET space_id=$1,state='pending_verification' WHERE group_id=$2", [another, groupId]);
    await expect(transaction((c) => authorizeSpaceAction(c, { ...personalContext(), policyVersion: before.policyVersion }, "read")))
      .rejects.toMatchObject({ code: "AGENT_SPACE_CONTEXT_STALE" });
  });

  it("does not retire a conversation because the space was renamed", async () => {
    const before = (await database().query<{ policy_version: number }>(
      "SELECT policy_version FROM spaces WHERE id=$1", [pair],
    )).rows[0]!.policy_version;
    // Название не входит в аудиторию: подъём версии из-за него отставил бы сессию, удалил
    // маршруты и погасил все висящие подтверждения ради косметики.
    await database().query("UPDATE spaces SET title='Пара 🪺' WHERE id=$1", [pair]);
    await expect(database().query<{ policy_version: number }>(
      "SELECT policy_version FROM spaces WHERE id=$1", [pair],
    )).resolves.toMatchObject({ rows: [{ policy_version: before }] });

    await database().query("UPDATE spaces SET state='archived' WHERE id=$1", [pair]);
    const after = (await database().query<{ policy_version: number }>(
      "SELECT policy_version FROM spaces WHERE id=$1", [pair],
    )).rows[0]!.policy_version;
    expect(after).toBe(before + 1);
  });

  it("lets a role narrow in an active space but never grow", async () => {
    await expect(database().query(
      "UPDATE space_memberships SET role='manager' WHERE space_id=$1 AND user_id=$2", [pair, spouse],
    )).rejects.toThrow(/AGENT_SPACE_ROLE_ESCALATION_FROZEN/);
    // Сужение прав внутри той же аудитории остаётся доступным всегда.
    await database().query(
      "UPDATE space_memberships SET role='child' WHERE space_id=$1 AND user_id=$2", [pair, spouse],
    );
    const forming = (await database().query<{ id: string }>(
      "INSERT INTO spaces(family_id,kind,title) VALUES($1,'shared','Forming') RETURNING id", [family],
    )).rows[0]!.id;
    await database().query(
      "INSERT INTO space_memberships(family_id,space_id,user_id,role,state) VALUES($1,$2,$3,'child','active')",
      [family, forming, owner],
    );
    await database().query(
      "UPDATE space_memberships SET role='manager' WHERE space_id=$1 AND user_id=$2", [forming, owner],
    );
  });

  it("does not let an active binding be swapped by deleting and inserting it", async () => {
    const groupId = (await database().query<{ id: string }>(
      "INSERT INTO telegram_groups(family_id,telegram_chat_id,title,type,message_mode) VALUES($1,'-302','Pair','family_private','addressed_only') RETURNING id", [family],
    )).rows[0]!.id;
    await bindGroupToSpace(database(), family, groupId, pair);
    const another = await makeSpace({ members: [[owner, "manager"]] });

    // Пересоздание строки обходило бы требование паузы, объявленное ветке UPDATE.
    await expect(transaction(async (client) => {
      await client.query("DELETE FROM space_bindings WHERE group_id=$1", [groupId]);
      await client.query(
        "INSERT INTO space_bindings(family_id,group_id,space_id,state) VALUES($1,$2,$3,'active')",
        [family, groupId, another],
      );
    })).rejects.toThrow(/AGENT_SPACE_BINDING_UNPROVEN/);
  });

  it("requires archiving a space before it can be deleted, and still lets the family go", async () => {
    // Удаление обнуляет область у строк и версию политики у сессий, и после отката режима они
    // снова читаются прежними предикатами по разделу — то есть аудитория тихо расширяется.
    await expect(database().query("DELETE FROM spaces WHERE id=$1", [pair]))
      .rejects.toThrow(/AGENT_SPACE_ARCHIVE_REQUIRED/);
    await database().query("UPDATE spaces SET state='archived' WHERE id=$1", [pair]);
    await database().query("DELETE FROM spaces WHERE id=$1", [pair]);

    // Удаление семьи уносит свои пространства целиком: данных, к которым они вели, тоже не станет.
    const other = (await database().query<{ id: string }>("INSERT INTO families(name) VALUES('Leaving') RETURNING id")).rows[0]!.id;
    await database().query("INSERT INTO spaces(family_id,kind,title,state) VALUES($1,'shared','Их область','active')", [other]);
    await database().query("DELETE FROM families WHERE id=$1", [other]);
  });

  it("prevents cross-family membership and changing an existing space identity", async () => {
    const anotherFamily = (await database().query<{ id: string }>("INSERT INTO families(name) VALUES('Other') RETURNING id")).rows[0]!.id;
    const spaceId = (await database().query<{ id: string }>("INSERT INTO spaces(family_id,kind,title) VALUES($1,'shared','Other') RETURNING id", [anotherFamily])).rows[0]!.id;
    await expect(database().query("INSERT INTO space_memberships(family_id,space_id,user_id,role) VALUES($1,$2,$3,'adult')", [anotherFamily, spaceId, owner]))
      .rejects.toMatchObject({ code: "23503" });
    await expect(database().query("UPDATE spaces SET family_id=$1 WHERE id=$2", [anotherFamily, pair]))
      .rejects.toThrow(/AGENT_SPACE_IDENTITY_IMMUTABLE/);
  });

  it("never accepts a policy version moving backwards", async () => {
    await expect(database().query("UPDATE spaces SET policy_version=policy_version-1 WHERE id=$1", [pair]))
      .rejects.toThrow(/AGENT_SPACE_POLICY_VERSION_REWIND/);
  });

  it("serializes revocation after an already authorized transaction, then denies new access", async () => {
    const reader = await database().connect();
    const revoker = await database().connect();
    let pending: Promise<unknown> | undefined;
    try {
      await reader.query("BEGIN");
      await resolveSpaceAccess(reader, personalContext());
      const pid = (await revoker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      pending = revoker.query("UPDATE space_memberships SET state='revoked' WHERE space_id=$1 AND user_id=$2", [pair, owner]);
      await expect.poll(async () => (await database().query<{ wait_event_type: string | null }>(
        "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid],
      )).rows[0]?.wait_event_type, { timeout: 5000, interval: 20 }).toBe("Lock");
      await reader.query("COMMIT");
      await pending;
      await expect(transaction((c) => resolveSpaceAccess(c, personalContext())))
        .rejects.toMatchObject({ code: "AGENT_SPACE_ACCESS_DENIED" });
    } finally {
      await reader.query("ROLLBACK");
      await pending;
      reader.release(); revoker.release();
    }
  });
});
