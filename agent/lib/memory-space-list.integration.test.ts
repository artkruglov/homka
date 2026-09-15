/**
 * Личный чат читает все области своего человека: его аудитория это он сам. Отзыв членства
 * закрывает область в том же SQL, а курсор остаётся привязан к доказанной области.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { database, closeDatabase } from "./database.js";
import { memoryRepository } from "./memory-repository.js";
import { memoryListRepository } from "./memory-list-repository.js";
import type { MemoryAuthorization } from "./memory-context.js";
const dbDescribe = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;
let auth: MemoryAuthorization, first: string, second: string;
async function makeSpace() {
  const id = (await database().query("INSERT INTO spaces(family_id,kind,title) VALUES($1,'shared','Shared') RETURNING id", [auth.familyId])).rows[0].id;
  await database().query("INSERT INTO space_memberships(family_id,space_id,user_id,role,state) VALUES($1,$2,$3,'manager','active')", [auth.familyId,id,auth.userId]);
  await database().query("UPDATE spaces SET state='active' WHERE id=$1", [id]);
  return id;
}
async function scoped(id: string): Promise<MemoryAuthorization> {
  const version = (await database().query("SELECT policy_version FROM spaces WHERE id=$1", [id])).rows[0].policy_version;
  return { ...auth, space: { spaceId: id, policyVersion: version } } as MemoryAuthorization;
}
dbDescribe("space-scoped memory lists", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE families,users CASCADE");
    const family = (await database().query("INSERT INTO families(name) VALUES('List spaces') RETURNING id")).rows[0].id;
    const user = (await database().query("INSERT INTO users(telegram_user_id,display_name) VALUES('list-space-owner','Owner') RETURNING id")).rows[0].id;
    await database().query("INSERT INTO family_memberships(family_id,user_id,role) VALUES($1,$2,'owner')", [family,user]);
    auth = { familyId: family, userId: user, groupId: null, scopes: ["personal","family"], role: "owner",
      telegramActorId: "list-space-owner", telegramActorKind: "telegram_user", telegramUserId: "list-space-owner" };
    first = await makeSpace(); second = await makeSpace();
    for (const [index, spaceId] of [first,first,second].entries()) {
      const claim = await memoryRepository.create(auth, { confirmation: "user_confirmed", content: `Space fact ${index}`,
        kind: "fact", operationKey: `space-fact-${index}`, provenance: { sessionId: "list-session", turnId: `turn-${index}` },
        scope: "family", sensitivity: "normal", source: "test:space-list" });
      // Model the already backfilled records; write-path cutover remains separate work.
      await database().query("UPDATE memory_items SET space_id=$2 WHERE id=$1", [claim.id,spaceId]);
    }
  });
  afterAll(closeDatabase);
  it("returns every space of the caller in their own chat", async () => {
    const a = await memoryListRepository.list(await scoped(first), { limit: 10 });
    const b = await memoryListRepository.list(await scoped(second), { limit: 10 });
    const all = ["Space fact 0","Space fact 1","Space fact 2"];
    expect(a.items.map((item) => item.content).sort()).toEqual(all);
    expect(b.items.map((item) => item.content).sort()).toEqual(all);
  });
  it("rechecks revocation with a stale authorization object", async () => {
    const old = await scoped(first);
    await database().query("UPDATE space_memberships SET state='revoked' WHERE space_id=$1", [first]);
    // Отозванная область исчезает из выдачи, даже если объект авторизации всё ещё её называет.
    expect((await memoryListRepository.list(old, { limit: 10 })).items.map((item) => item.content))
      .toEqual(["Space fact 2"]);
  });
  it("binds pagination to the selected space", async () => {
    const page = await memoryListRepository.list(await scoped(first), { limit: 1 });
    expect(page.nextCursor).not.toBeNull();
    await expect(memoryListRepository.list(await scoped(second), { limit: 1, cursor: page.nextCursor! }))
      .rejects.toMatchObject({ code: "AGENT_MEMORY_CURSOR_INVALID" });
  });
});
