/**
 * Durable memory-thread creation notice recovery integration tests.
 *
 * Constructs covered:
 * - A stale started notice becomes terminally ambiguous and is never selected for a duplicate send.
 * - A later pending notice remains independently deliverable after stale-state recovery.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import { THREAD_NOTICE_DELIVERY_LEASE_MILLISECONDS } from "./memory-config.js";
import { memoryThreadNoticeRepository } from "./memory-thread-notice-repository.js";
import {
  createBroadThread,
  createThreadRepositoryFixture,
} from "./memory-thread-repository.integration-fixtures.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

describeWithDatabase("memory thread notice durable recovery", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE users, families CASCADE");
  });

  afterAll(closeDatabase);

  it("terminally marks a stale started send without selecting it again", async () => {
    const fixture = await createThreadRepositoryFixture();
    await createBroadThread(fixture);
    const thread = await database().query<{ id: string }>(
      "SELECT id FROM memory_threads WHERE family_id = $1",
      [fixture.familyId],
    );
    await database().query(
      `UPDATE memory_thread_creation_notices
       SET status = 'started', delivery_token = gen_random_uuid(),
           delivery_started_at = $2, delivery_diagnostic_code = NULL
       WHERE thread_id = $1`,
      [thread.rows[0]!.id, new Date(Date.now() - THREAD_NOTICE_DELIVERY_LEASE_MILLISECONDS - 1)],
    );

    await expect(memoryThreadNoticeRepository.takePending(
      fixture.auth,
      fixture.conversationId,
    )).resolves.toBeNull();
    await expect(database().query(
      `SELECT status, delivery_token, delivery_diagnostic_code
       FROM memory_thread_creation_notices WHERE thread_id = $1`,
      [thread.rows[0]!.id],
    )).resolves.toMatchObject({ rows: [{
      delivery_diagnostic_code: "AGENT_MEMORY_THREAD_NOTICE_DELIVERY_AMBIGUOUS",
      delivery_token: null,
      status: "ambiguous",
    }] });
  });
});
