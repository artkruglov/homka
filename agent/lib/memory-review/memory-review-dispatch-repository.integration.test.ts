/**
 * Memory-review dispatch crash-recovery PostgreSQL integration tests.
 *
 * Constructs covered:
 * - Bounded pre-handoff recovery, owner alerts, stale markers, and exact Eve-root ownership.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDatabase, database } from "../database.js";
import { createMainAgentMemoryFixture } from "../memory-agent-write.integration-fixtures.js";
import { memoryReviewDispatchRepository } from "./memory-review-dispatch-repository.js";
import { memoryReviewOwnerAlertRepository } from "./memory-review-owner-alert-repository.js";
import { memoryReviewRepository } from "./memory-review-repository.js";
import { memoryReviewSessionRepository } from "./memory-review-session-repository.js";
import { bindGroupToSpace } from "../spaces/two-space-fixture.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

async function insertUserMessage(input: {
  conversationId: string;
  groupId: string;
  sequence: number;
}) {
  return (await database().query<{ id: string }>(
    `INSERT INTO telegram_group_messages
       (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
        telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
     VALUES ($1, $2, $3, $3, 'user', 'telegram:agent-memory-author',
             'agent-memory-author', 'Анна', false, 'text', $4, now()) RETURNING id`,
    [input.conversationId, input.groupId, input.sequence, `Сообщение памяти ${input.sequence}`],
  )).rows[0]!;
}

async function claimBackgroundBatch() {
  const fixture = await createMainAgentMemoryFixture();
  for (let sequence = 2; sequence <= 51; sequence += 1) {
    const source = await insertUserMessage({
      conversationId: fixture.conversationId,
      groupId: fixture.groupId,
      sequence,
    });
    await memoryReviewRepository.observePassiveMessage({
      groupId: fixture.groupId,
      timelineEntryId: source.id,
    });
  }
  const [claim] = await memoryReviewDispatchRepository.claimPending({
    leaseMilliseconds: 60_000,
    limit: 1,
    now: new Date("2026-08-12T10:00:00.000Z"),
  });
  return { claim: claim!, fixture };
}

describeWithDatabase("memory review dispatch repository", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE users, families CASCADE");
  });

  afterAll(closeDatabase);

  it("keeps the neighbouring space out of the prompt of a review batch", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const bound = (await database().query<{ id: string }>(
      "INSERT INTO spaces(family_id,kind,title) VALUES($1,'shared','Пара') RETURNING id",
      [fixture.familyId],
    )).rows[0]!.id;
    const other = (await database().query<{ id: string }>(
      "INSERT INTO spaces(family_id,kind,title) VALUES($1,'shared','Хозяйство') RETURNING id",
      [fixture.familyId],
    )).rows[0]!.id;
    for (const space of [bound, other]) {
      await database().query(
        "INSERT INTO space_memberships(family_id,space_id,user_id,role,state) VALUES($1,$2,$3,'adult','active')",
        [fixture.familyId, space, fixture.userId],
      );
      await database().query("UPDATE spaces SET state='active' WHERE id=$1", [space]);
    }
    await bindGroupToSpace(database(), fixture.familyId, fixture.groupId, bound);
    await database().query(
      "UPDATE family_space_runtime SET mode='spaces', reason='Переход' WHERE family_id=$1",
      [fixture.familyId],
    );
    await database().query(
      `INSERT INTO memory_items_all(family_id,scope,content,source,kind,confirmation,sensitivity,
         operation_key,space_id)
       VALUES($1,'family','Секрет соседней области','test','fact','user_confirmed','normal',
              'review-other-space',$2)`,
      [fixture.familyId, other],
    );
    for (let sequence = 2; sequence <= 51; sequence += 1) {
      const source = await insertUserMessage({
        conversationId: fixture.conversationId, groupId: fixture.groupId, sequence,
      });
      await memoryReviewRepository.observePassiveMessage({
        groupId: fixture.groupId, timelineEntryId: source.id,
      });
    }

    const [claim] = await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000, limit: 1, now: new Date("2026-08-12T10:00:00.000Z"),
    });

    // Блок уже сохранённых записей уходит в промпт целиком, поэтому чужая область в нём недопустима.
    expect(claim!.prompt).not.toContain("Секрет соседней области");
  });

  it("gives a background review turn the space of the conversation it reviews", async () => {
    const { claim, fixture } = await claimBackgroundBatch();
    // Ворота перехода: у группы есть подтверждённая привязка, живых сессий у семьи нет.
    const space = (await database().query<{ id: string }>(
      "INSERT INTO spaces(family_id,kind,title) VALUES($1,'shared','Пара') RETURNING id",
      [fixture.familyId],
    )).rows[0]!.id;
    await database().query(
      "INSERT INTO space_memberships(family_id,space_id,user_id,role,state) VALUES($1,$2,$3,'adult','active')",
      [fixture.familyId, space, fixture.userId],
    );
    await database().query("UPDATE spaces SET state='active' WHERE id=$1", [space]);
    await bindGroupToSpace(database(), fixture.familyId, fixture.groupId, space);
    await database().query(
      "UPDATE family_space_runtime SET mode='spaces', reason='Переход' WHERE family_id=$1",
      [fixture.familyId],
    );

    const session = await memoryReviewSessionRepository.prepare(claim, new Date("2026-08-12T10:00:01.000Z"));

    // Без области ход проверки останавливается на общей границе инструментов и ничего не пишет.
    expect(session.spacePolicy?.spaceId).toBe(space);
    const stored = (await database().query<{ space_id: string; space_policy_version: number }>(
      "SELECT space_id,space_policy_version FROM conversation_sessions WHERE id=$1", [session.id],
    )).rows[0]!;
    expect(stored.space_id).toBe(space);
    expect(stored.space_policy_version).toBe(session.spacePolicy!.policyVersion);
  });

  it("retires a prepared background session when its Eve handoff is ambiguous", async () => {
    const { claim } = await claimBackgroundBatch();
    const session = await memoryReviewSessionRepository.prepare(
      claim,
      new Date("2026-08-12T10:00:01.000Z"),
    );
    await memoryReviewDispatchRepository.markAmbiguous(
      claim,
      "AGENT_MEMORY_REVIEW_DISPATCH_MARKER_AMBIGUOUS",
      session.id,
    );

    await expect(database().query(
      `SELECT app_session.task_state::text, app_session.retired_at,
              count(source.timeline_entry_id)::integer AS source_count,
              alert.status::text AS alert_status
         FROM conversation_sessions AS app_session
         JOIN memory_review_batches AS batch ON batch.application_session_id = app_session.id
         LEFT JOIN memory_review_batch_sources AS source ON source.batch_id = batch.id
         LEFT JOIN memory_review_owner_alerts AS alert ON alert.batch_id = batch.id
        WHERE app_session.id = $1
        GROUP BY app_session.id, alert.id`,
      [session.id],
    )).resolves.toMatchObject({
      rows: [{
        alert_status: "pending",
        retired_at: expect.any(Date),
        source_count: 50,
        task_state: "failed",
      }],
    });
  });

  it("retries one pre-handoff failure, then blocks and alerts without releasing sources", async () => {
    const { claim } = await claimBackgroundBatch();

    await expect(memoryReviewDispatchRepository.failClaim(
      claim,
      "AGENT_MEMORY_REVIEW_SESSION_PREPARATION_FAILED",
    )).resolves.toBe("retry_scheduled");
    await expect(database().query(
      `SELECT batch.status::text, batch.recovery_attempts,
              batch.last_recovery_diagnostic_code,
              count(source.timeline_entry_id)::integer AS source_count,
              count(alert.id)::integer AS alert_count,
              (SELECT metadata->>'recoveryAttempt' FROM audit_events
                WHERE event_type = 'memory_review.retry_scheduled' AND subject_id = batch.id
                ORDER BY created_at DESC LIMIT 1) AS audited_recovery_attempt
         FROM memory_review_batches AS batch
         LEFT JOIN memory_review_batch_sources AS source ON source.batch_id = batch.id
         LEFT JOIN memory_review_owner_alerts AS alert ON alert.batch_id = batch.id
        WHERE batch.id = $1 GROUP BY batch.id`,
      [claim.batchId],
    )).resolves.toMatchObject({ rows: [{
      alert_count: 0,
      audited_recovery_attempt: "1",
      last_recovery_diagnostic_code: "AGENT_MEMORY_REVIEW_SESSION_PREPARATION_FAILED",
      recovery_attempts: 1,
      source_count: 50,
      status: "pending",
    }] });

    const [retried] = await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000,
      limit: 1,
      now: new Date("2026-08-12T10:01:00.000Z"),
    });
    await expect(memoryReviewDispatchRepository.failClaim(
      retried!,
      "AGENT_MEMORY_REVIEW_SESSION_PREPARATION_FAILED",
    )).resolves.toBe("failed");
    await expect(database().query(
      `SELECT batch.status::text, count(source.timeline_entry_id)::integer AS source_count,
              alert.status::text AS alert_status
         FROM memory_review_batches AS batch
         LEFT JOIN memory_review_batch_sources AS source ON source.batch_id = batch.id
         LEFT JOIN memory_review_owner_alerts AS alert ON alert.batch_id = batch.id
        WHERE batch.id = $1 GROUP BY batch.id, alert.id`,
      [claim.batchId],
    )).resolves.toMatchObject({ rows: [{
      alert_status: "pending",
      source_count: 50,
      status: "failed",
    }] });
  });

  it("leases a terminal alert to the current owner and records one-shot delivery", async () => {
    const { claim } = await claimBackgroundBatch();
    const session = await memoryReviewSessionRepository.prepare(claim, new Date());
    await memoryReviewDispatchRepository.markAmbiguous(
      claim,
      "AGENT_MEMORY_REVIEW_HANDOFF_AMBIGUOUS",
      session.id,
    );

    const [alert] = await memoryReviewOwnerAlertRepository.claimPending({
      leaseMilliseconds: 60_000,
      limit: 1,
      now: new Date("2026-08-12T10:01:00.000Z"),
    });
    expect(alert).toMatchObject({
      batchId: claim.batchId,
      diagnosticCode: "AGENT_MEMORY_REVIEW_HANDOFF_AMBIGUOUS",
      groupTitle: "Семья",
      ownerTelegramUserId: "agent-memory-author",
    });
    await memoryReviewOwnerAlertRepository.markDelivered(alert!);

    await expect(memoryReviewOwnerAlertRepository.claimPending({
      leaseMilliseconds: 60_000,
      limit: 1,
      now: new Date("2026-08-12T10:02:00.000Z"),
    })).resolves.toEqual([]);
    await expect(database().query(
      "SELECT status::text, completed_at FROM memory_review_owner_alerts WHERE id = $1",
      [alert!.alertId],
    )).resolves.toMatchObject({
      rows: [{ completed_at: expect.any(Date), status: "delivered" }],
    });
  });

  it("does not lease an alert to an owner who is asleep", async () => {
    // Предупреждение ждёт утра целиком: взять аренду и не отправить значит держать строку
    // занятой, а владелец всё равно не прочитает её раньше.
    const { claim } = await claimBackgroundBatch();
    const session = await memoryReviewSessionRepository.prepare(claim, new Date());
    await memoryReviewDispatchRepository.markAmbiguous(
      claim, "AGENT_MEMORY_REVIEW_HANDOFF_AMBIGUOUS", session.id,
    );
    await database().query(
      `INSERT INTO user_notification_settings (user_id, timezone, quiet_start, quiet_end)
       SELECT id, 'Europe/Moscow', '22:00', '08:00' FROM users WHERE telegram_user_id = $1
       ON CONFLICT (user_id) DO UPDATE
         SET timezone = EXCLUDED.timezone, quiet_start = EXCLUDED.quiet_start,
             quiet_end = EXCLUDED.quiet_end`,
      ["agent-memory-author"],
    );
    await expect(memoryReviewOwnerAlertRepository.claimPending({
      leaseMilliseconds: 60_000, limit: 1, now: new Date("2026-08-12T23:30:00.000Z"),
    })).resolves.toEqual([]);
    await expect(database().query(
      "SELECT status::text FROM memory_review_owner_alerts WHERE batch_id = $1", [claim.batchId],
    )).resolves.toMatchObject({ rows: [{ status: "pending" }] });

    const [morning] = await memoryReviewOwnerAlertRepository.claimPending({
      leaseMilliseconds: 60_000, limit: 1, now: new Date("2026-08-13T06:30:00.000Z"),
    });
    expect(morning).toMatchObject({ batchId: claim.batchId });
    await database().query(
      "DELETE FROM user_notification_settings WHERE user_id IN (SELECT id FROM users WHERE telegram_user_id = $1)",
      ["agent-memory-author"],
    );
  });

  it("terminalizes an ownerless alert without blocking other claims", async () => {
    const { claim, fixture } = await claimBackgroundBatch();
    const session = await memoryReviewSessionRepository.prepare(claim, new Date());
    await memoryReviewDispatchRepository.markAmbiguous(
      claim,
      "AGENT_MEMORY_REVIEW_HANDOFF_AMBIGUOUS",
      session.id,
    );
    await database().query(
      "DELETE FROM family_memberships WHERE family_id = $1 AND role = 'owner'",
      [fixture.familyId],
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(memoryReviewOwnerAlertRepository.claimPending({
      leaseMilliseconds: 60_000,
      limit: 1,
      now: new Date("2026-08-12T10:01:00.000Z"),
    })).resolves.toEqual([]);
    await expect(database().query(
      `SELECT status::text, delivery_diagnostic_code
         FROM memory_review_owner_alerts WHERE batch_id = $1`,
      [claim.batchId],
    )).resolves.toMatchObject({ rows: [{
      delivery_diagnostic_code: "AGENT_MEMORY_REVIEW_OWNER_ALERT_OWNER_MISSING",
      status: "failed",
    }] });
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(
      "AGENT_MEMORY_REVIEW_OWNER_ALERT_OWNER_MISSING",
    ));
    consoleError.mockRestore();
  });

  it("reuses an unstarted application session after a pre-marker process crash", async () => {
    const { claim } = await claimBackgroundBatch();
    const first = await memoryReviewSessionRepository.prepare(
      claim,
      new Date("2026-08-12T10:00:01.000Z"),
    );
    const recovered = await memoryReviewSessionRepository.prepare(
      claim,
      new Date("2026-08-12T10:02:00.000Z"),
    );

    expect(recovered).toEqual(first);
  });

  it("terminalizes a stale dispatch marker and its one-shot application session", async () => {
    const { claim } = await claimBackgroundBatch();
    const session = await memoryReviewSessionRepository.prepare(
      claim,
      new Date("2026-08-12T10:00:01.000Z"),
    );
    await memoryReviewDispatchRepository.markDispatchStarted(claim, session.id);

    await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000,
      limit: 1,
      now: new Date("2026-08-12T10:02:00.000Z"),
    });

    await expect(database().query(
      `SELECT batch.status::text, batch.diagnostic_code, app_session.task_state::text,
              app_session.retired_at
         FROM memory_review_batches AS batch
         JOIN conversation_sessions AS app_session ON app_session.id = batch.application_session_id
        WHERE batch.id = $1`,
      [claim.batchId],
    )).resolves.toMatchObject({ rows: [{
      diagnostic_code: "AGENT_MEMORY_REVIEW_DISPATCH_TIMEOUT_AMBIGUOUS",
      retired_at: expect.any(Date),
      status: "ambiguous",
      task_state: "failed",
    }] });
  });

  it("keeps a running background batch intact for a competing Eve root failure", async () => {
    const { claim } = await claimBackgroundBatch();
    const session = await memoryReviewSessionRepository.prepare(claim, new Date());
    await memoryReviewDispatchRepository.markDispatchStarted(claim, session.id);
    await memoryReviewDispatchRepository.markRunning(claim, {
      applicationSessionId: session.id,
      eveSessionId: "eve-authoritative-root",
    });

    await memoryReviewDispatchRepository.markSessionAmbiguous({
      batchId: claim.batchId,
      diagnosticCode: "AGENT_MEMORY_REVIEW_SESSION_FAILED_AMBIGUOUS",
      eveSessionId: "eve-competing-root",
    });

    await expect(database().query(
      `SELECT batch.status::text, count(source.timeline_entry_id)::integer AS source_count
         FROM memory_review_batches AS batch
         LEFT JOIN memory_review_batch_sources AS source ON source.batch_id = batch.id
        WHERE batch.id = $1 GROUP BY batch.id`,
      [claim.batchId],
    )).resolves.toMatchObject({ rows: [{ source_count: 50, status: "running" }] });
  });

  it("fails completion without a source binding and keeps the lane blocked", async () => {
    const { claim } = await claimBackgroundBatch();
    const session = await memoryReviewSessionRepository.prepare(claim, new Date());
    await memoryReviewDispatchRepository.markDispatchStarted(claim, session.id);
    await memoryReviewRepository.bindEveTurn({
      applicationSessionId: session.id,
      batchId: claim.batchId,
      eveSessionId: "eve-unbound-review",
      eveTurnId: "turn-unbound-review",
    });

    const completion = {
      batchId: claim.batchId,
      completedAt: new Date("2026-08-12T10:00:02.000Z"),
      eveSessionId: "eve-unbound-review",
      eveTurnId: "turn-unbound-review",
    };
    await expect(memoryReviewRepository.completeBatch(completion)).resolves.toBe("failed");
    await expect(memoryReviewRepository.completeBatch(completion)).resolves.toBe("failed");
    await expect(database().query(
      `SELECT batch.status::text, batch.diagnostic_code,
              lane.processed_through_sequence::text AS lane_cursor,
              app_session.task_state::text, app_session.retired_at,
              count(DISTINCT source.timeline_entry_id)::integer AS source_count,
              count(DISTINCT alert.id)::integer AS alert_count
         FROM memory_review_batches AS batch
         JOIN memory_review_lanes AS lane ON lane.id = batch.lane_id
         JOIN conversation_sessions AS app_session ON app_session.id = batch.application_session_id
         LEFT JOIN memory_review_batch_sources AS source ON source.batch_id = batch.id
         LEFT JOIN memory_review_owner_alerts AS alert ON alert.batch_id = batch.id
        WHERE batch.id = $1
        GROUP BY batch.id, lane.id, app_session.id`,
      [claim.batchId],
    )).resolves.toMatchObject({ rows: [{
      alert_count: 1,
      diagnostic_code: "AGENT_MEMORY_REVIEW_SOURCE_BINDING_MISSING",
      lane_cursor: "0",
      retired_at: expect.any(Date),
      source_count: 50,
      status: "failed",
      task_state: "failed",
    }] });
  });

  it("releases the review batch of a chat session that failed without writing memory", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const session = await database().query<{ id: string }>(
      `INSERT INTO conversation_sessions
         (thread_id, generation, family_id, group_id, scope, kind, conversation_key,
          continuation_token, started_at, last_activity_at)
       VALUES (gen_random_uuid(), 0, $1, $2, 'family', 'canonical', 'review-session-failure',
               'review-session-failure', now(), now()) RETURNING id`,
      [fixture.familyId, fixture.groupId],
    );
    let source: { id: string } | null = null;
    // Eight passive messages: the shortest tail an addressed turn still reviews inline.
    for (let sequence = 2; sequence <= 9; sequence += 1) {
      source = await insertUserMessage({
        conversationId: fixture.conversationId,
        groupId: fixture.groupId,
        sequence,
      });
    }
    const batch = await memoryReviewRepository.prepareInteractiveTurn({
      applicationSessionId: session.rows[0]!.id,
      groupId: fixture.groupId,
      timelineEntryId: source!.id,
    });
    await memoryReviewRepository.bindEveTurn({
      applicationSessionId: session.rows[0]!.id,
      batchId: batch!.batchId,
      eveSessionId: "eve-interactive-session-failure",
      eveTurnId: "turn-interactive-session-failure",
    });
    await database().query(
      "UPDATE conversation_sessions SET eve_session_id = $2 WHERE id = $1",
      [session.rows[0]!.id, "eve-interactive-session-failure"],
    );

    await expect(memoryReviewDispatchRepository.markInteractiveSessionAmbiguous({
      continuationToken: "review-session-failure",
      diagnosticCode: "AGENT_MEMORY_REVIEW_SESSION_FAILED_AMBIGUOUS",
      eveSessionId: "eve-interactive-session-failure",
    })).resolves.toBe("recorded");
    // Ход этой сессии ничего не записал и наследника за собой не оставил, поэтому пакет
    // освобождается целиком. Прежний терминал `ambiguous` сохранял источники «для ремонта», но
    // ремонта не существовало: он занимал место на курсоре и глушил лейн навсегда.
    await expect(database().query(
      "SELECT count(*)::integer AS batches FROM memory_review_batches WHERE id = $1",
      [batch!.batchId],
    )).resolves.toMatchObject({ rows: [{ batches: 0 }] });
    await expect(database().query(
      `SELECT rotation_requested_at, rotation_reason, pending_operation
         FROM conversation_sessions WHERE id = $1`,
      [session.rows[0]!.id],
    )).resolves.toMatchObject({
      rows: [{ pending_operation: false, rotation_reason: "session_failed", rotation_requested_at: expect.any(Date) }],
    });
    await expect(database().query(
      "SELECT count(*)::integer AS alerts FROM memory_review_owner_alerts",
    )).resolves.toMatchObject({ rows: [{ alerts: 0 }] });
    // Источники вернулись в непроверенный хвост и разберутся обычным ходом.
    const repeated = await memoryReviewRepository.prepareInteractiveTurn({
      applicationSessionId: session.rows[0]!.id,
      groupId: fixture.groupId,
      timelineEntryId: source!.id,
    });
    expect(repeated?.sourceCount).toBe(9);
  });
});
