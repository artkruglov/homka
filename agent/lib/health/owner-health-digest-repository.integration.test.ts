/**
 * Owner health digest repository tests (PostgreSQL).
 *
 * Constructs covered:
 * - The family owner with a Telegram id is a recipient.
 * - The report counts a rotation, written memory and a stuck review lane of that family only.
 * - Дайджест уходит в личку владельца, то есть в его личную область, поэтому ни одна строка отчёта
 *   не называет чат, человека или содержимое: после разделения областей это был бы перенос
 *   названия соседней области в чужую.
 * - The daily claim is taken once; a released claim can be taken again; a completed one cannot.
 * - Model usage is summarised in dollars inside the window and purged after retention; the
 *   low-balance alert is claimed once per family per day.
 */
import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { createMemoryFamilyFixture, createMemoryInput } from "../memory-repository.integration-fixtures.js";
import { memoryRepository } from "../memory-repository.js";
import { formatOwnerHealthDigest } from "./owner-health-digest.js";
import { modelUsageRepository } from "./model-usage-repository.js";
import { ownerBalanceAlertRepository } from "./owner-balance-alert-repository.js";
import { ownerHealthDigestRepository } from "./owner-health-digest-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

describeWithDatabase("ownerHealthDigestRepository", () => {
  afterAll(closeDatabase);

  it("keeps unresolved proactive failures visible without exposing content or other families", async () => {
    const suffix = `proactive-health-${Date.now()}`;
    const family = await createMemoryFamilyFixture(suffix);
    const other = await createMemoryFamilyFixture(`${suffix}-other`);
    const now = new Date();
    const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1_000);
    for (const fixture of [family, other]) {
      await database().query(
        `INSERT INTO reminders
           (family_id, owner_user_id, author_user_id, scope, content, timezone,
            telegram_chat_id, recurrence_anchor_local, due_at, available_at, status, updated_at)
         SELECT $1, $2, $2, 'personal', 'PRIVATE_REMINDER_CONTENT', 'Europe/Moscow',
                $3, localtimestamp, now(), now(), state::reminder_status, now() - interval '3 days'
           FROM unnest(ARRAY['failed', 'failed', 'active', 'completed', 'paused']) AS state`,
        [fixture.familyId, fixture.member.userId, fixture.member.telegramUserId],
      );
      await database().query(
        `INSERT INTO agent_schedules
           (family_id, owner_user_id, author_user_id, scope, title, user_request, scenario_prompt,
            timezone, recurrence_kind, recurrence_interval, recurrence_anchor_local, next_run_at,
            telegram_chat_id, telegram_chat_type, status, updated_at)
         SELECT $1, $2, $2, 'personal', 'PRIVATE_SCHEDULE_TITLE', 'PRIVATE_REQUEST', 'PRIVATE_PROMPT',
                'Europe/Moscow', 'once', 1, localtimestamp, now(), $3, 'private',
                state::agent_schedule_status, now() - interval '3 days'
           FROM unnest(ARRAY['failed', 'active', 'completed', 'paused']) AS state`,
        [fixture.familyId, fixture.member.userId, fixture.member.telegramUserId],
      );
    }
    const report = await ownerHealthDigestRepository.report(family.familyId, windowStart, now);
    expect(report.proactiveFailures).toEqual({ reminders: 2, schedules: 1 });
    expect(JSON.stringify(report)).not.toContain("PRIVATE_");

    await database().query("UPDATE reminders SET status = 'paused' WHERE family_id = $1", [family.familyId]);
    await database().query("UPDATE agent_schedules SET status = 'paused' WHERE family_id = $1", [family.familyId]);
    const resolved = await ownerHealthDigestRepository.report(family.familyId, windowStart, now);
    expect(resolved.proactiveFailures).toEqual({ reminders: 0, schedules: 0 });
  });

  it("reports the family's rotations, memory and stuck lanes, and claims the day once", async () => {
    const suffix = `health-${Date.now()}`;
    const family = await createMemoryFamilyFixture(suffix);
    const now = new Date();
    const windowStart = new Date(now.getTime() - 60 * 60 * 1_000);

    const recipients = await ownerHealthDigestRepository.recipients();
    // Настройки читаются вместе с адресатом: без них диспетчер не знает, спит ли он сейчас.
    expect(recipients).toContainEqual({ familyId: family.familyId, ownerTelegramUserId: `owner-${suffix}`,
      quietEnd: null, quietStart: null, timezone: "UTC" });

    await memoryRepository.create(family.owner, createMemoryInput("family", `${suffix}-fact`, "Семья любит гречку"));
    await database().query(
      `INSERT INTO conversation_sessions
         (thread_id, generation, family_id, owner_user_id, scope, conversation_key, continuation_token,
          started_at, last_activity_at, rotation_requested_at, rotation_reason, kind)
       VALUES (gen_random_uuid(), 0, $1, $2, 'personal', $3, $4, now(), now(), now(), 'session_failed', 'canonical')`,
      [family.familyId, family.owner.userId, `key-${suffix}`, `token-${suffix}`],
    );
    // «Начни новый контекст» по просьбе человека не сбой: 14 сентября 2026 сводка насчитала такую
    // ротацию «после сбоя».
    await database().query(
      `INSERT INTO conversation_sessions
         (thread_id, generation, family_id, owner_user_id, scope, conversation_key, continuation_token,
          started_at, last_activity_at, rotation_requested_at, rotation_reason, kind)
       VALUES (gen_random_uuid(), 0, $1, $2, 'personal', $3, $4, now(), now(), now(), 'user_requested', 'canonical')`,
      [family.familyId, family.owner.userId, `key-requested-${suffix}`, `token-requested-${suffix}`],
    );
    // Writing memory may already have created the owner's personal conversation; reuse it.
    await database().query(
      `INSERT INTO application_conversations
         (family_id, owner_user_id, telegram_chat_id, scope, scope_partition_key, label)
       VALUES ($1, $2, $3, 'personal', $2, $4) ON CONFLICT DO NOTHING`,
      [family.familyId, family.owner.userId, `chat-${suffix}`, `Личный чат ${suffix}`],
    );
    const conversation = await database().query<{ id: string; label: string }>(
      `SELECT id, label FROM application_conversations
        WHERE family_id = $1 AND scope = 'personal' AND owner_user_id = $2`,
      [family.familyId, family.owner.userId],
    );
    const label = conversation.rows[0]!.label;
    const lane = await database().query<{ id: string }>(
      `INSERT INTO memory_review_lanes (conversation_id, processed_through_sequence)
       VALUES ($1, 10) RETURNING id`,
      [conversation.rows[0]!.id],
    );
    await database().query(
      `INSERT INTO memory_review_batches
         (lane_id, conversation_id, batch_kind, status, predecessor_sequence, from_sequence,
          through_sequence, source_count, diagnostic_code, started_at, completed_at)
       VALUES ($1, $2, 'background', 'failed', 10, 11, 12, 2, 'MODEL_CALL_FAILED', now(), now())`,
      [lane.rows[0]!.id, conversation.rows[0]!.id],
    );

    const report = await ownerHealthDigestRepository.report(family.familyId, windowStart, now);
    expect(report.rotations.count).toBe(1);
    expect(report.memoryWritten).toContainEqual(expect.objectContaining({ count: 1, scope: "family" }));
    expect(report.lanes.blocked).toEqual({
      codes: [{ code: "failed/MODEL_CALL_FAILED", count: 1 }], count: 1, waiting: 0,
    });
    expect(report.reviewBatches.failed).toBe(1);
    // Счётчик заканчивает молчание, а название чата для этого не нужно.
    expect(JSON.stringify(report)).not.toContain(label);
    expect(formatOwnerHealthDigest(report)).not.toContain(label);

    const digestDate = "2026-09-09";
    await expect(ownerHealthDigestRepository.claim(family.familyId, digestDate, now)).resolves.toBe(true);
    await expect(ownerHealthDigestRepository.claim(family.familyId, digestDate, now)).resolves.toBe(false);
    await ownerHealthDigestRepository.release(family.familyId, digestDate);
    await expect(ownerHealthDigestRepository.claim(family.familyId, digestDate, now)).resolves.toBe(true);
    await ownerHealthDigestRepository.complete(family.familyId, digestDate, now, 42);
    await ownerHealthDigestRepository.release(family.familyId, digestDate);
    await expect(ownerHealthDigestRepository.claim(family.familyId, digestDate, now)).resolves.toBe(false);
  });

  it("prices model usage inside the window, purges it after retention and claims one balance alert a day", async () => {
    // Fixed dates in 2020 keep this window free of rows other suites write at the current time.
    const offPeak = new Date("2020-01-04T12:00:00.000Z");
    const peak = new Date("2020-01-06T07:00:00.000Z");
    const flash = { cacheHitTokens: 1_000_000, cacheMissTokens: 1_000_000, modelId: "deepseek-v4-flash", outputTokens: 1_000_000, webSearchCalls: 2 };
    await modelUsageRepository.record(flash, offPeak);
    await modelUsageRepository.record(flash, peak);
    await modelUsageRepository.record({ ...flash, modelId: "unknown-model", webSearchCalls: 0 }, peak);
    await modelUsageRepository.record(flash, new Date("2019-12-01T12:00:00.000Z"));

    const summary = await modelUsageRepository.summary(new Date("2020-01-01T00:00:00.000Z"), new Date("2020-01-07T00:00:00.000Z"));
    expect(summary).toMatchObject({ calls: 3, cacheHitTokens: 3_000_000, cacheMissTokens: 3_000_000, outputTokens: 3_000_000, unpricedCalls: 1, webSearchCalls: 4 });
    expect(summary.costUsd).toBeCloseTo(0.753 + 1.506, 6);

    await expect(modelUsageRepository.purgeExpired(new Date("2020-01-15T00:00:00.000Z"))).resolves.toBe(1);
    await expect(database().query("SELECT count(*)::int AS rows FROM model_usage_events WHERE created_at < '2020-02-01'"))
      .resolves.toMatchObject({ rows: [{ rows: 3 }] });
    await database().query("DELETE FROM model_usage_events WHERE created_at < '2020-02-01'");

    const family = await createMemoryFamilyFixture(`balance-${Date.now()}`);
    const now = new Date();
    await expect(ownerBalanceAlertRepository.claim(family.familyId, "2026-09-14", now)).resolves.toBe(true);
    await expect(ownerBalanceAlertRepository.claim(family.familyId, "2026-09-14", now)).resolves.toBe(false);
    await ownerBalanceAlertRepository.release(family.familyId, "2026-09-14");
    await expect(ownerBalanceAlertRepository.claim(family.familyId, "2026-09-14", now)).resolves.toBe(true);
    await ownerBalanceAlertRepository.complete(family.familyId, "2026-09-14", now);
    await ownerBalanceAlertRepository.release(family.familyId, "2026-09-14");
    await expect(ownerBalanceAlertRepository.claim(family.familyId, "2026-09-14", now)).resolves.toBe(false);
  });
});
