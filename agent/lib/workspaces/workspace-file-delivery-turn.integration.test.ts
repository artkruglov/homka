/**
 * Per-turn workspace delivery deduplication PostgreSQL tests (upstream 61363db, 4eca2c9).
 *
 * Constructs covered:
 * - Parallel calls of one turn reserve one delivery; the loser sees an unconfirmed send as ambiguous.
 * - A later call in the same turn gets the confirmed message back as a duplicate, even in another
 *   presentation; a later turn may send the same bytes again.
 * - A definitive failure does not block another call; another forum topic is another recipient.
 * - A delivery without a turn (backend video completion) keeps plain exact-once semantics.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { createWorkspaceBinaryRepository } from "./workspace-binary-repository.js";
import { createWorkspaceFileDeliveryRepository } from "./workspace-file-delivery-repository.js";
import { createWorkspaceRepository } from "./workspace-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;
const roots: string[] = [];

async function fixture() {
  const familyId = (await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('Delivery turn') RETURNING id",
  )).rows[0]!.id;
  const userId = (await database().query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ('delivery-turn-owner', 'Владелец') RETURNING id",
  )).rows[0]!.id;
  await database().query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
    [familyId, userId],
  );
  const auth = {
    familyId,
    groupId: null,
    groupType: null,
    role: "owner" as const,
    telegramChatType: "private" as const,
    userId,
  };
  const root = await mkdtemp(join(tmpdir(), "osinara-delivery-turn-"));
  roots.push(root);
  const binaries = createWorkspaceBinaryRepository(root, createWorkspaceRepository(root));
  await binaries.writeBinary(auth, {
    bytes: Buffer.from("same picture"),
    mediaType: "text/plain",
    operationKey: "delivery-turn-write",
    path: "out/picture.txt",
    scope: "personal",
  });
  return {
    auth,
    binaries,
    input: {
      chatId: "101",
      path: "out/picture.txt",
      presentation: "photo" as const,
      scope: "personal" as const,
      turnId: "eve-session:turn-1",
    },
  };
}

describeWithDatabase("workspace delivery per-turn deduplication", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE workspace_file_deliveries, workspace_operations, workspaces, family_memberships, users, families CASCADE",
    );
  });
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });
  afterAll(closeDatabase);

  it("reserves once across parallel calls and reports the confirmed message afterwards", async () => {
    const { auth, binaries, input } = await fixture();
    // Separate repository instances share only PostgreSQL, as separate workers do.
    const repositories = [
      createWorkspaceFileDeliveryRepository(binaries),
      createWorkspaceFileDeliveryRepository(binaries),
    ];
    const results = await Promise.allSettled(repositories.map((repository, index) =>
      repository.begin(auth, {
        ...input,
        operationKey: `send-${index}`,
        presentation: index === 0 ? "photo" : "document",
      })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected"))
      .toMatchObject({ reason: { code: "AGENT_WORKSPACE_FILE_DELIVERY_AMBIGUOUS" } });
    const winner = results.findIndex((result) => result.status === "fulfilled");
    await expect(database().query("SELECT status, turn_id FROM workspace_file_deliveries"))
      .resolves.toMatchObject({ rows: [{ status: "started", turn_id: "eve-session:turn-1" }] });

    await repositories[winner]!.complete(`send-${winner}`, "77");
    await expect(repositories[0]!.begin(auth, {
      ...input,
      operationKey: "follow-up-document",
      presentation: "document",
    })).resolves.toMatchObject({ status: "duplicate", telegramMessageId: "77" });
    // The winner's own replay still resolves as its completed delivery.
    await expect(repositories[0]!.begin(auth, {
      ...input,
      operationKey: `send-${winner}`,
      presentation: winner === 0 ? "photo" : "document",
    })).resolves.toMatchObject({ status: "completed", telegramMessageId: "77" });
    await expect(repositories[0]!.begin(auth, {
      ...input,
      operationKey: "later-turn",
      turnId: "eve-session:turn-2",
    })).resolves.toMatchObject({ status: "reserved" });
  });

  it("lets another call through after a definitive failure", async () => {
    const { auth, binaries, input } = await fixture();
    const repository = createWorkspaceFileDeliveryRepository(binaries);
    await repository.begin(auth, { ...input, operationKey: "rejected-photo" });
    await repository.fail("rejected-photo", "AGENT_WORKSPACE_FILE_TYPE_UNSUPPORTED");
    await expect(repository.begin(auth, {
      ...input,
      operationKey: "send-document",
      presentation: "document",
    })).resolves.toMatchObject({ status: "reserved" });
  });

  it("treats another forum topic as another recipient", async () => {
    const { auth, binaries, input } = await fixture();
    const repository = createWorkspaceFileDeliveryRepository(binaries);
    await repository.begin(auth, { ...input, messageThreadId: 1, operationKey: "topic-1" });
    await repository.complete("topic-1", "77");
    await expect(repository.begin(auth, { ...input, messageThreadId: 2, operationKey: "topic-2" }))
      .resolves.toMatchObject({ status: "reserved" });
  });

  it("keeps a delivery without a turn on plain exact-once semantics", async () => {
    const { auth, binaries, input } = await fixture();
    const repository = createWorkspaceFileDeliveryRepository(binaries);
    const { turnId: _turnId, ...backend } = input;
    await repository.begin(auth, { ...backend, operationKey: "video-delivery:job-1" });
    await repository.complete("video-delivery:job-1", "77");
    await expect(repository.begin(auth, { ...backend, operationKey: "video-delivery:job-1" }))
      .resolves.toMatchObject({ status: "completed", telegramMessageId: "77" });
    await expect(repository.begin(auth, { ...backend, operationKey: "video-delivery:job-2" }))
      .resolves.toMatchObject({ status: "reserved" });
  });
});
