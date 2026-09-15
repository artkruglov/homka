/** Space changes must replace both model history and sandbox identity, including parked turns. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, database } from "../database.js";
import { sessionRepository, type PrepareSessionInput } from "./session-repository.js";
import type { SpaceContext } from "../spaces/space-access.js";
import { bindGroupToSpace } from "../spaces/two-space-fixture.js";

const dbDescribe = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;
let family: string, owner: string, spouse: string, pair: string, personal: string;
function input(spaceId?: string): PrepareSessionInput & { spaceContext?: SpaceContext } {
  return { baseContinuationToken: "space-owner::", familyId: family, userId: owner,
    groupId: null, kind: "canonical", scope: "personal", telegramForumTopicId: null,
    now: new Date("2026-09-10T10:00:00Z"),
    ...(spaceId ? { spaceContext: { familyId: family, userId: owner, spaceId, chat: { type: "private" as const } } } : {}),
  };
}
async function space(kind: string, members: string[]) {
  const id = (await database().query("INSERT INTO spaces(family_id,kind,title,owner_user_id) VALUES($1,$2,'Session space',$3) RETURNING id", [family,kind,kind === "personal" ? owner : null])).rows[0].id;
  for (const user of members) await database().query("INSERT INTO space_memberships(family_id,space_id,user_id,role,state) VALUES($1,$2,$3,'manager','active')", [family,id,user]);
  await database().query("UPDATE spaces SET state='active' WHERE id=$1", [id]);
  return id;
}

dbDescribe("space-bound session preparation", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE families,users CASCADE");
    family = (await database().query("INSERT INTO families(name) VALUES('Session family') RETURNING id")).rows[0].id;
    const ids: string[] = [];
    for (const name of ["space-owner", "space-spouse"]) {
      const id = (await database().query("INSERT INTO users(telegram_user_id,display_name) VALUES($1,$1) RETURNING id", [name])).rows[0].id;
      await database().query("INSERT INTO family_memberships(family_id,user_id,role) VALUES($1,$2,'member')", [family,id]);
      ids.push(id);
    }
    [owner,spouse] = ids as [string,string];
    personal = await space("personal", [owner]);
    pair = await space("shared", [owner,spouse]);
  });
  afterAll(closeDatabase);

  it("stores the live policy and cannot resume the bound session without its context", async () => {
    const first = await sessionRepository.prepareTurn(input(pair));
    const policy = (await database().query("SELECT policy_version FROM spaces WHERE id=$1", [pair])).rows[0].policy_version;
    // Название нужно блоку режима: в личном чате человек обязан видеть активную область.
    expect(first.spacePolicy).toEqual({ spaceId: pair, policyVersion: policy, title: "Session space" });
    expect((await database().query("SELECT space_id FROM conversation_sessions WHERE id=$1", [first.id])).rows[0].space_id).toBe(pair);
    expect((await sessionRepository.prepareTurn(input(pair))).id).toBe(first.id);
    await expect(sessionRepository.prepareTurn(input())).rejects.toMatchObject({ code: "AGENT_SESSION_SPACE_CONTEXT_REQUIRED" });
  });

  it("replaces history and sandbox on selection change and removes old reply aliases", async () => {
    const first = await sessionRepository.prepareTurn(input(personal));
    await sessionRepository.registerRouteAlias(first.id, "space-owner::123");
    const second = await sessionRepository.prepareTurn(input(pair));
    expect(second.id).not.toBe(first.id);
    expect(second.sandboxSessionId).not.toBe(first.sandboxSessionId);
    expect(second.continuationToken).not.toBe(first.continuationToken);
    expect(second.rotated).toBe(true);
    expect(await sessionRepository.hasRoute("space-owner::123")).toBe(false);
    expect((await sessionRepository.prepareTurn(input(pair))).id).toBe(second.id);
  });

  it("replaces a parked personal turn when membership changes", async () => {
    const first = await sessionRepository.prepareTurn(input(pair));
    await sessionRepository.parkSession({ applicationSessionId: first.id, pendingRequestId: "old-approval", requesterTelegramUserId: "space-owner", requesterUserId: owner });
    await database().query("UPDATE space_memberships SET state='revoked' WHERE space_id=$1 AND user_id=$2", [pair,spouse]);
    const second = await sessionRepository.prepareTurn(input(pair));
    expect(second.sandboxSessionId).not.toBe(first.sandboxSessionId);
    expect((await database().query("SELECT retired_at,pending_operation FROM conversation_sessions WHERE id=$1", [first.id])).rows[0])
      .toMatchObject({ retired_at: expect.any(Date), pending_operation: false });
  });

  it("checks live membership and verified caller identity before selecting a route", async () => {
    await sessionRepository.prepareTurn(input(pair));
    await database().query("UPDATE space_memberships SET state='revoked' WHERE space_id=$1 AND user_id=$2", [pair,owner]);
    await expect(sessionRepository.prepareTurn(input(pair))).rejects.toMatchObject({ code: "AGENT_SPACE_ACCESS_DENIED" });
    const forged = input(pair); forged.spaceContext = { ...forged.spaceContext!, userId: spouse };
    await expect(sessionRepository.prepareTurn(forged)).rejects.toMatchObject({ code: "AGENT_SESSION_SPACE_CONTEXT_INVALID" });
  });

  it("does not adopt legacy unbound history into a selected space", async () => {
    const legacy = await sessionRepository.prepareTurn(input());
    const next = await sessionRepository.prepareTurn(input(pair));
    expect(next.sandboxSessionId).not.toBe(legacy.sandboxSessionId);
  });

  it("refuses a stale group approval and starts a different sandbox for the new canonical", async () => {
    const group = (await database().query("INSERT INTO telegram_groups(family_id,telegram_chat_id,title,type,message_mode) VALUES($1,'-space-group','Space group','family_private','addressed_only') RETURNING id", [family])).rows[0].id;
    await bindGroupToSpace(database(), family,group,pair);
    const request: PrepareSessionInput = { ...input(pair), scope: "family", groupId: group, userId: null,
      baseContinuationToken: `osinara:group:${group}:main`,
      spaceContext: { familyId: family, userId: owner, spaceId: pair, chat: { type: "group", groupId: group } } };
    const first = await sessionRepository.prepareTurn(request);
    await sessionRepository.parkSession({ applicationSessionId: first.id, pendingRequestId: "group-approval", requesterTelegramUserId: "space-owner", requesterUserId: owner });
    await sessionRepository.registerRouteAlias(first.id, "-space-group::77");
    await database().query("UPDATE space_memberships SET state='revoked' WHERE space_id=$1 AND user_id=$2", [pair,spouse]);
    await expect(sessionRepository.prepareTurn({ ...request, kind: "task", baseContinuationToken: "-space-group::77" }))
      .rejects.toMatchObject({ code: "AGENT_SESSION_SPACE_CONTEXT_STALE" });
    const next = await sessionRepository.prepareTurn(request);
    expect(next.sandboxSessionId).not.toBe(first.sandboxSessionId);
    expect(next.continuationToken).not.toBe(first.continuationToken);
  });

  it("keeps the same space policy and sandbox across ordinary rotation", async () => {
    const first = await sessionRepository.prepareTurn(input(pair));
    await database().query("UPDATE conversation_sessions SET rotation_requested_at=now() WHERE id=$1", [first.id]);
    const next = await sessionRepository.prepareTurn(input(pair));
    expect(next.id).not.toBe(first.id);
    expect(next.sandboxSessionId).toBe(first.sandboxSessionId);
    expect(next.spacePolicy).toEqual(first.spacePolicy);
    const stored = (await database().query("SELECT space_policy_version FROM conversation_sessions WHERE id=$1", [next.id])).rows[0].space_policy_version;
    expect(stored).toBe(first.spacePolicy!.policyVersion);
    await expect(database().query("UPDATE conversation_sessions SET space_policy_version=space_policy_version+1 WHERE id=$1", [next.id]))
      .rejects.toThrow(/AGENT_SESSION_SPACE_POLICY_IMMUTABLE/);
    await database().query("DELETE FROM families WHERE id=$1", [family]);
  });
});
