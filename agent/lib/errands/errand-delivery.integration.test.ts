/** Real ledger and policy, replaced network: one public result or an honest non-delivery. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, database } from "../database.js";
import { createTwoSpaceFixture, twoSpaceMemoryAuthorization, type TwoSpaceFixture } from "../spaces/two-space-fixture.js";
import { errandRepository } from "./errand-repository.js";
import { listErrandRecipients } from "./errand-recipients.js";
import { createErrandDelivery } from "./errand-delivery.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("AGENT_TEST_DATABASE_UNSAFE");
let fixture: TwoSpaceFixture;
const morning = new Date("2026-09-13T09:00:00Z");
const invocation = () => ({ operationKey: randomUUID(), sessionId: "initiator", turnId: "turn",
  privateQuery: "Это личная причина, не передавай её" });
const auth = () => twoSpaceMemoryAuthorization({ as: fixture.owner, spaceId: fixture.pairSpaceId,
  chat: "private", fixture });
async function prepared(mode: "draft" | "send" = "send") {
  const actor = await auth();
  const [recipient] = await listErrandRecipients(actor);
  const created = await errandRepository.execute(actor, { action: "create", mode,
    recipientRef: recipient!.recipientRef, brief: "Парки на выходные" }, invocation());
  const ready = await errandRepository.execute(actor, { action: "result", id: created.errand!.id,
    version: 1, text: "Парк у реки", sources: [] }, invocation());
  return ready.errand!.id;
}

(enabled ? describe : describe.skip)("errand delivery", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE families,users CASCADE");
    fixture = await createTwoSpaceFixture("errand-delivery");
    await database().query(`INSERT INTO user_notification_settings(user_id,timezone,quiet_start,quiet_end)
      VALUES($1,'UTC',NULL,NULL)`, [fixture.spouse.userId]);
  });
  afterAll(closeDatabase);

  it("never sends a draft, even when asked to dispatch its id", async () => {
    const send = vi.fn().mockResolvedValue("900");
    expect(await createErrandDelivery({ send })(await prepared("draft"), morning))
      .toMatchObject({ state: "ready", delivered: false });
    expect(send).not.toHaveBeenCalled();
  });

  it("delivers exactly once under concurrent dispatch and never includes private rationale", async () => {
    const id = await prepared();
    const send = vi.fn().mockResolvedValue("900");
    const deliver = createErrandDelivery({ send });
    await Promise.all([deliver(id, morning), deliver(id, morning)]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({ chatId: fixture.spouse.telegramUserId,
      text: expect.stringContaining("Парк у реки") });
    expect(send.mock.calls[0]![0].text).not.toContain("личная причина");
    expect(await deliver(id, morning)).toMatchObject({ state: "sent", delivered: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("preserves long selections and all source URLs with one durable delivery", async () => {
    const id = await prepared();
    const longText = "Проверенная подробная подборка. ".repeat(180);
    const sources = Array.from({ length: 10 }, (_, i) => ({ url: `https://example.org/${i}/${"x".repeat(500)}`, checkedAt: morning.toISOString() }));
    await database().query("UPDATE errand_results SET text=$2,sources=$3 WHERE errand_id=$1", [id,longText,JSON.stringify(sources)]);
    const send = vi.fn().mockResolvedValue("902");
    const deliver = createErrandDelivery({ send });
    expect(await deliver(id,morning)).toMatchObject({ state: "sent", delivered: true });
    expect(send).toHaveBeenCalledTimes(1);
    const delivered = send.mock.calls[0]![0].text;
    expect(delivered).toContain(longText);
    for (const source of sources) expect(delivered).toContain(source.url);
    expect(delivered).not.toContain("личная причина");
    expect(await deliver(id,morning)).toMatchObject({ state: "sent" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps an uncertain send terminal and does not call it a rejection", async () => {
    const send = vi.fn().mockRejectedValue(new Error("response lost"));
    const deliver = createErrandDelivery({ send });
    const id = await prepared();
    expect(await deliver(id, morning)).toMatchObject({ state: "ambiguous", delivered: null });
    expect(await deliver(id, morning)).toMatchObject({ state: "ambiguous", delivered: null });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("defers through quiet hours without claiming a send, then delivers", async () => {
    await database().query("UPDATE user_notification_settings SET quiet_start='22:00',quiet_end='08:00' WHERE user_id=$1",
      [fixture.spouse.userId]);
    const send = vi.fn().mockResolvedValue("900");
    const deliver = createErrandDelivery({ send });
    const id = await prepared();
    expect(await deliver(id, new Date("2026-09-12T23:00:00Z")))
      .toMatchObject({ state: "queued", reason: "quiet_hours", delivered: false });
    expect((await database().query("SELECT count(*)::int AS count FROM errand_deliveries")).rows[0].count).toBe(0);
    expect(await deliver(id, morning)).toMatchObject({ delivered: true });
  });

  it("obeys opt-out and membership revocation after creation", async () => {
    const send = vi.fn().mockResolvedValue("900");
    const deliver = createErrandDelivery({ send });
    const muted = await prepared();
    const revoked = await prepared();
    await database().query("UPDATE user_notification_settings SET initiative_enabled=false WHERE user_id=$1", [fixture.spouse.userId]);
    expect(await deliver(muted, morning)).toMatchObject({ state: "failed", reason: "muted", delivered: false });
    await database().query("DELETE FROM family_memberships WHERE user_id=$1 AND family_id=$2", [fixture.spouse.userId, fixture.familyId]);
    expect(await deliver(revoked, morning)).toMatchObject({ state: "failed", delivered: false });
    expect(send).not.toHaveBeenCalled();
  });

  it("honours cancellation before dispatch and serializes the recipient's daily limit", async () => {
    const send = vi.fn().mockResolvedValue("900");
    const deliver = createErrandDelivery({ send });
    const cancelled = await prepared();
    await errandRepository.execute(await auth(), { action: "cancel", id: cancelled }, invocation());
    expect(await deliver(cancelled, morning)).toMatchObject({ state: "cancelled", delivered: false });
    await database().query("UPDATE user_notification_settings SET initiative_daily_limit=1 WHERE user_id=$1", [fixture.spouse.userId]);
    const first = await prepared();
    const second = await prepared();
    const outcomes = await Promise.all([deliver(first, morning), deliver(second, morning)]);
    expect(outcomes.filter(outcome => outcome.delivered)).toHaveLength(1);
    expect(outcomes).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "daily_limit", state: "queued" })]));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("rechecks the initiator's membership and treats an invalid Telegram receipt as ambiguous", async () => {
    const send = vi.fn().mockResolvedValue("not-a-message-id");
    const deliver = createErrandDelivery({ send });
    const uncertain = await prepared();
    expect(await deliver(uncertain, morning)).toMatchObject({ state: "ambiguous", delivered: null });
    const revoked = await prepared();
    await database().query("DELETE FROM family_memberships WHERE user_id=$1 AND family_id=$2",
      [fixture.owner.userId, fixture.familyId]);
    expect(await deliver(revoked, morning)).toMatchObject({ state: "failed", reason: "access_revoked" });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
