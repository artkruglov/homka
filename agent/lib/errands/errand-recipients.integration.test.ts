/** The private recipient catalogue must not become a family directory across tenants. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, database } from "../database.js";
import { createTwoSpaceFixture, twoSpaceMemoryAuthorization, type TwoSpaceFixture } from "../spaces/two-space-fixture.js";
import { listErrandRecipients } from "./errand-recipients.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE");
}
let fixture: TwoSpaceFixture;
const auth = (chat: "private" | "group" = "private") => twoSpaceMemoryAuthorization({
  as: fixture.owner, spaceId: fixture.pairSpaceId, chat, fixture,
});

(enabled ? describe : describe.skip)("errand recipients", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE families,users CASCADE");
    fixture = await createTwoSpaceFixture("errand-catalogue");
    await createTwoSpaceFixture("other-family");
  });
  afterAll(closeDatabase);

  it("returns only the other verified family member as an opaque reference", async () => {
    const recipients = await listErrandRecipients(await auth());
    expect(recipients).toEqual([{ name: "Супруга", recipientRef: expect.any(String) }]);
    expect(recipients[0]!.recipientRef).toMatch(/^[a-f0-9-]{36}$/u);
    expect(recipients[0]!.recipientRef).not.toBe(fixture.spouse.userId);
  });

  it("immediately drops revoked membership, even though an old participant row remains", async () => {
    await listErrandRecipients(await auth());
    await database().query("DELETE FROM family_memberships WHERE family_id=$1 AND user_id=$2",
      [fixture.familyId, fixture.spouse.userId]);
    expect(await listErrandRecipients(await auth())).toEqual([]);
  });

  it("refuses a group call and a revoked initiator", async () => {
    await expect(listErrandRecipients(await auth("group"))).rejects.toThrow(/AGENT_ERRAND_PRIVATE_ONLY/u);
    const stale = await auth();
    await database().query("DELETE FROM family_memberships WHERE family_id=$1 AND user_id=$2",
      [fixture.familyId, fixture.owner.userId]);
    await expect(listErrandRecipients(stale)).rejects.toThrow(/AGENT_TASK_ACCESS_DENIED/u);
  });
});
