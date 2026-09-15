/**
 * Session route resolution and retention isolation PostgreSQL tests.
 *
 * Constructs covered:
 * - Unbound delivery aliases retain the prepared session without becoming resumable early.
 * - Exact failure-token matches take precedence over conflicting stale aliases.
 * - A failed retention row is retried after its cooldown; while cooling down the sweep moves on.
 * - A retired row that still carries a live pending operation is never leased for deletion.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { sessionRepository } from "./session-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

async function fixture() {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('Route retention') RETURNING id",
  );
  const user = await database().query<{ id: string }>(
    `INSERT INTO users (telegram_user_id, display_name)
     VALUES ('route-retention-owner', 'Owner') RETURNING id`,
  );
  await database().query(
    `INSERT INTO family_memberships (family_id, user_id, role)
     VALUES ($1, $2, 'owner')`,
    [family.rows[0]!.id, user.rows[0]!.id],
  );
  return { familyId: family.rows[0]!.id, userId: user.rows[0]!.id };
}

describeWithDatabase("session route and retention isolation", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE conversation_session_routes, conversation_sessions, conversation_route_generations, telegram_groups, family_memberships, users, families CASCADE",
    );
  });
  afterAll(closeDatabase);

  it("keeps an unbound delivery alias attached to its prepared session", async () => {
    const f = await fixture();
    const current = await sessionRepository.prepareTurn({
      baseContinuationToken: "101::910",
      kind: "canonical",
      telegramForumTopicId: null,
      familyId: f.familyId,
      groupId: null,
      now: new Date("2026-07-12T12:00:00.000Z"),
      scope: "personal",
      userId: f.userId,
    });
    await sessionRepository.registerRouteAlias(current.id, "101::911");

    // The alias is not resumable before Eve binds, but prepareTurn must not fork the app session.
    await expect(sessionRepository.hasRoute("101::911")).resolves.toBe(false);
    const reply = await sessionRepository.prepareTurn({
      baseContinuationToken: "101::911",
      kind: "canonical",
      telegramForumTopicId: null,
      familyId: f.familyId,
      groupId: null,
      now: new Date("2026-07-12T12:01:00.000Z"),
      scope: "personal",
      userId: f.userId,
    });
    expect(reply.id).toBe(current.id);
  });

  it("prefers an exact continuation token over a conflicting stale route", async () => {
    const f = await fixture();
    const group = await database().query<{ id: string }>(
      `INSERT INTO telegram_groups
         (family_id, telegram_chat_id, title, type, message_mode)
       VALUES ($1, '-100-failure-token', 'Failure token', 'family_private', 'addressed_only')
       RETURNING id`,
      [f.familyId],
    );
    const input = {
      baseContinuationToken: "osinara:group:failure-token:main",
      kind: "canonical" as const,
      telegramForumTopicId: null,
      familyId: f.familyId,
      groupId: group.rows[0]!.id,
      now: new Date("2026-07-12T12:00:00.000Z"),
      scope: "family" as const,
      userId: null,
    };
    const parked = await sessionRepository.prepareTurn(input);
    await sessionRepository.bindEveSession(parked.id, "wrun_parked_failure_token");
    await sessionRepository.parkSession({
      applicationSessionId: parked.id,
      pendingRequestId: "request-failure-token",
      requesterTelegramUserId: "route-retention-owner",
      requesterUserId: f.userId,
    });
    const replacement = await sessionRepository.prepareTurn(input);
    await sessionRepository.bindEveSession(replacement.id, "wrun_replacement_failure_token");
    await database().query(
      `INSERT INTO conversation_session_routes (base_continuation_token, session_id)
       VALUES ($1, $2)`,
      [replacement.continuationToken, parked.id],
    );

    await expect(sessionRepository.recordSessionFailedByContinuationToken(
      replacement.continuationToken,
      "wrun_replacement_failure_token",
    )).resolves.toBe("recorded");
    await expect(database().query(
      `SELECT id, pending_operation, rotation_requested_at IS NOT NULL AS rotation_requested
         FROM conversation_sessions WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[parked.id, replacement.id]],
    )).resolves.toMatchObject({
      rows: expect.arrayContaining([
        expect.objectContaining({ id: parked.id, pending_operation: true }),
        expect.objectContaining({ id: replacement.id, rotation_requested: true }),
      ]),
    });
  });

  // Upstream 63d7e65: parking a failed row until someone cleared the error by hand left sessions
  // undeletable, each keeping a Workflow run alive that every agent start then re-read in full.
  it("retries a failed retention row after its cooldown", async () => {
    const f = await fixture();
    const inserted = await database().query<{ id: string }>(
      `INSERT INTO conversation_sessions
         (thread_id, generation, family_id, owner_user_id, scope, kind, conversation_key,
          continuation_token, eve_session_id, started_at, last_activity_at, retired_at,
          delete_after, cleanup_error_code)
       VALUES
         (gen_random_uuid(), 0, $1, $2, 'personal', 'canonical', 'poisoned', 'poisoned',
          'wrun_poisoned', now(), now(), now(), '2026-01-01', 'AGENT_STORAGE_CORRUPT'),
         (gen_random_uuid(), 0, $1, $2, 'personal', 'canonical', 'eligible', 'eligible',
          'wrun_eligible', now(), now(), now(), '2026-01-02', NULL)
       RETURNING id`,
      [f.familyId, f.userId],
    );

    // A row that failed before the retry column existed is tried again, not parked forever.
    const retried = await sessionRepository.claimExpiredForDeletion(
      new Date("2026-04-02T00:00:00.000Z"),
    );
    expect(retried).toMatchObject({ eveSessionId: "wrun_poisoned", id: inserted.rows[0]!.id });

    await sessionRepository.failDeletion(
      retried!.id,
      retried!.leaseToken,
      "AGENT_STORAGE_CORRUPT",
      new Date("2026-04-02T00:00:01.000Z"),
    );

    // While it cools down the sweep moves on to the next session instead of stalling on it.
    const next = await sessionRepository.claimExpiredForDeletion(
      new Date("2026-04-02T00:10:00.000Z"),
    );
    expect(next).toMatchObject({ eveSessionId: "wrun_eligible", id: inserted.rows[1]!.id });
    await sessionRepository.completeDeletion(next!.id, next!.leaseToken);

    await expect(sessionRepository.claimExpiredForDeletion(
      new Date("2026-04-02T00:30:00.000Z"),
    )).resolves.toBeNull();
    await expect(sessionRepository.claimExpiredForDeletion(
      new Date("2026-04-02T02:00:00.000Z"),
    )).resolves.toMatchObject({ eveSessionId: "wrun_poisoned", id: inserted.rows[0]!.id });
  });

  it("never leases a retired session that still waits on a pending operation", async () => {
    const f = await fixture();
    await database().query(
      `INSERT INTO conversation_sessions
         (thread_id, generation, family_id, owner_user_id, scope, kind, conversation_key,
          continuation_token, eve_session_id, started_at, last_activity_at, retired_at,
          delete_after, pending_operation)
       VALUES
         (gen_random_uuid(), 0, $1, $2, 'personal', 'canonical', 'pending', 'pending',
          'wrun_pending', now(), now(), now(), '2026-01-01', true)`,
      [f.familyId, f.userId],
    );

    await expect(sessionRepository.claimExpiredForDeletion(
      new Date("2026-04-02T00:00:00.000Z"),
    )).resolves.toBeNull();
  });
});
