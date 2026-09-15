/** Область хода выводится из самого чата и появляется только после включения режима семьи. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { provisionMemberPersonalSpace } from "./space-provisioning.js";
import { resolveTurnSpaceContext, type TurnSpaceSelection } from "./turn-space-selection.js";
import { createTwoSpaceFixture, type TwoSpaceFixture } from "./two-space-fixture.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const dbDescribe = enabled ? describe : describe.skip;

let fixture: TwoSpaceFixture;

async function select(input: Omit<TurnSpaceSelection, "familyId">) {
  const client = await database().connect();
  try {
    return await resolveTurnSpaceContext(client, { ...input, familyId: fixture.familyId });
  } finally {
    client.release();
  }
}

async function enableSpaces(): Promise<void> {
  await database().query(
    "UPDATE family_space_runtime SET mode='spaces', reason='Переход' WHERE family_id=$1",
    [fixture.familyId],
  );
}

dbDescribe("turn space selection", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE families,users CASCADE");
    fixture = await createTwoSpaceFixture("selection");
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await provisionMemberPersonalSpace(client, { familyId: fixture.familyId, userId: fixture.owner.userId });
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });
  afterAll(closeDatabase);

  it("selects nothing while the family still runs the previous mode", async () => {
    await expect(select({ chatType: "private", groupId: null, userId: fixture.owner.userId }))
      .resolves.toBeNull();
    await expect(select({ chatType: "supergroup", groupId: fixture.groupId, userId: fixture.owner.userId }))
      .resolves.toBeNull();
  });

  it("gives a private chat the caller's own space", async () => {
    await enableSpaces();
    const context = await select({ chatType: "private", groupId: null, userId: fixture.owner.userId });
    expect(context?.chat).toEqual({ type: "private" });
    const kind = (await database().query<{ kind: string; owner_user_id: string }>(
      "SELECT kind,owner_user_id FROM spaces WHERE id=$1", [context!.spaceId],
    )).rows[0]!;
    expect(kind).toEqual({ kind: "personal", owner_user_id: fixture.owner.userId });
  });

  it("gives a group chat the space its chat is bound to", async () => {
    await enableSpaces();
    const context = await select({ chatType: "supergroup", groupId: fixture.groupId, userId: fixture.owner.userId });
    expect(context?.spaceId).toBe(fixture.pairSpaceId);
    expect(context?.chat).toEqual({ groupId: fixture.groupId, type: "supergroup" });
  });

  it("selects nothing for a chat whose audience is not confirmed", async () => {
    await enableSpaces();
    await database().query(
      "UPDATE space_bindings SET state='pending_verification' WHERE group_id=$1", [fixture.groupId],
    );
    await expect(select({ chatType: "supergroup", groupId: fixture.groupId, userId: fixture.owner.userId }))
      .resolves.toBeNull();
  });

  it("selects nothing for a person who has no space of their own yet", async () => {
    await enableSpaces();
    await expect(select({ chatType: "private", groupId: null, userId: fixture.spouse.userId }))
      .resolves.toBeNull();
  });

  it("refuses a private chat that also names a group", async () => {
    await enableSpaces();
    await expect(select({ chatType: "private", groupId: fixture.groupId, userId: fixture.owner.userId }))
      .resolves.toBeNull();
  });
});
