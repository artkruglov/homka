/** Durable private intent, separately disclosed results, explicit recipient answers. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, database } from "../database.js";
import { createTwoSpaceFixture, twoSpaceMemoryAuthorization, type TwoSpaceFixture } from "../spaces/two-space-fixture.js";
import { listErrandRecipients } from "./errand-recipients.js";
import { errandRepository } from "./errand-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("AGENT_TEST_DATABASE_UNSAFE");
let fixture: TwoSpaceFixture;
const auth = (as = fixture.owner) => twoSpaceMemoryAuthorization({
  as, spaceId: fixture.pairSpaceId, chat: "private", fixture,
});
const invocation = (key = randomUUID()) => ({ operationKey: key, privateQuery: "Моя личная причина: устал",
  sessionId: "private-initiator-session", turnId: "private-turn" });
async function create(mode: "draft" | "send" = "draft", key = randomUUID()) {
  const actor = await auth();
  const [recipient] = await listErrandRecipients(actor);
  return errandRepository.execute(actor, { action: "create", brief: "Подборка парков", mode,
    recipientRef: recipient!.recipientRef }, invocation(key));
}

(enabled ? describe : describe.skip)("errand repository", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE families,users CASCADE");
    fixture = await createTwoSpaceFixture("errand-records");
  });
  afterAll(closeDatabase);

  it("keeps drafts and private rationale out of the recipient's reads", async () => {
    const created = await create();
    const ready = await errandRepository.execute(await auth(), { action: "result", id: created.errand!.id,
      version: created.errand!.version, text: "Три парка", sources: [] }, invocation());
    expect(ready.errand).toMatchObject({ state: "ready", resultVersion: 1 });
    expect((await errandRepository.execute(await auth(fixture.spouse),
      { action: "list", view: "received" }, invocation())).errands).toEqual([]);
    await expect(errandRepository.execute(await auth(fixture.spouse),
      { action: "get", id: ready.errand!.id }, invocation())).rejects.toThrow(/AGENT_ERRAND_ACCESS_DENIED/u);
    expect((await database().query("SELECT count(*)::int AS count FROM errand_deliveries")).rows[0].count).toBe(0);
  });

  it("cancels while research is running and refuses its late result", async () => {
    const created = await create("send");
    await errandRepository.execute(await auth(), { action: "cancel", id: created.errand!.id }, invocation());
    await expect(errandRepository.execute(await auth(), { action: "result", id: created.errand!.id,
      version: created.errand!.version, text: "Поздний результат", sources: [] }, invocation()))
      .rejects.toThrow(/AGENT_ERRAND_VERSION_CONFLICT|AGENT_ERRAND_TRANSITION_DENIED/u);
  });

  it("replays creation without duplication and refuses a changed brief under the same operation", async () => {
    const key = randomUUID();
    const first = await create("send", key);
    const second = await create("send", key);
    expect(second).toMatchObject({ replayed: true, errand: { id: first.errand!.id } });
    const [recipient] = await listErrandRecipients(await auth());
    await expect(errandRepository.execute(await auth(), { action: "create", mode: "send",
      recipientRef: recipient!.recipientRef, brief: "Другая задача" }, invocation(key)))
      .rejects.toThrow(/AGENT_ERRAND_OPERATION_CONFLICT/u);
  });

  it("shares only a delivered result and an explicitly submitted recipient answer", async () => {
    const created = await create("send");
    const result = await errandRepository.execute(await auth(), { action: "result", id: created.errand!.id,
      version: 1, text: "Парк у реки", sources: [] }, invocation());
    const id = result.errand!.id;
    // This fixture represents a confirmed transport receipt; delivery races get separate tests.
    await database().query(`INSERT INTO errand_deliveries(errand_id,result_version,state,telegram_message_id,completed_at)
      VALUES($1,1,'sent','501',now())`, [id]);
    await database().query("UPDATE errands SET state='sent' WHERE id=$1", [id]);
    const received = await errandRepository.execute(await auth(fixture.spouse), { action: "get", id }, invocation());
    expect(received.errand).toMatchObject({ result: { text: "Парк у реки" } });
    expect(JSON.stringify(received)).not.toContain("Моя личная причина");
    expect(received.errand).not.toHaveProperty("privateQuery");
    await expect(errandRepository.execute(await auth(),
      { action: "share_answer", id, resultVersion: 1, text: "За супругу: да" }, invocation()))
      .rejects.toThrow(/AGENT_ERRAND_ACCESS_DENIED/u);
    await errandRepository.execute(await auth(fixture.spouse),
      { action: "share_answer", id, resultVersion: 1, text: "Выбираю парк у реки" }, invocation());
    const status = await errandRepository.execute(await auth(), { action: "get", id }, invocation());
    expect(status.errand!.answers).toEqual([expect.objectContaining({ text: "Выбираю парк у реки" })]);
    expect((await database().query("SELECT count(*)::int AS count FROM shared_tasks")).rows[0].count).toBe(0);
  });
});
