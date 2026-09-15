import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, database } from "../database.js";
import { telegramIngressRepository } from "../telegram-ingress-repository.js";
import { reconcileVerifiedGroupMigration } from "./reconcile.js";

import { legacyBoundaryQuery } from "../spaces/legacy-space-audit.js";
import { memoryReviewRepository } from "../memory-review/memory-review-repository.js";
import { insertReviewSession, insertReviewUserMessage } from "../memory-review/memory-review.integration-fixtures.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("Unsafe database");
const suite = enabled ? describe : describe.skip;
async function fixture() {
  const f = (await database().query("INSERT INTO families(name) VALUES('migration') RETURNING id")).rows[0].id;
  const g = (await database().query(`INSERT INTO telegram_groups(family_id,telegram_chat_id,title,type,message_mode)
    VALUES($1,'-123','Pair','family_private','all') RETURNING id`, [f])).rows[0].id;
  for (const [updateId, chat, fields] of [
    [901, { id: -123, type: "group" }, { migrate_to_chat_id: -100456 }],
    [902, { id: -100456, type: "supergroup" }, { migrate_from_chat_id: -123 }],
  ] as const) {
    await telegramIngressRepository.enqueue({
      updateId: String(updateId), continuationKey: `telegram:${chat.id}`,
      payload: { update_id: updateId, message: { message_id: 1, chat, ...fields } },
    });
  }
  return { familyId: f, groupId: g };
}
suite("operator reconciliation of verified group migration", () => {
  beforeEach(async () => { await database().query("TRUNCATE families,users,telegram_ingress_queues CASCADE"); });
  afterAll(closeDatabase);

  it("preserves group and conversation identity and applies the paired update only once", async () => {
    const { groupId } = await fixture();
    const before = (await database().query("SELECT id FROM application_conversations WHERE telegram_group_id=$1", [groupId])).rows[0];
    await expect(reconcileVerifiedGroupMigration("901")).resolves.toEqual({ groupId, replayed: false });
    await expect(reconcileVerifiedGroupMigration("902")).resolves.toEqual({ groupId, replayed: true });
    expect((await database().query("SELECT telegram_chat_id FROM telegram_groups WHERE id=$1", [groupId])).rows[0].telegram_chat_id).toBe("-100456");
    expect((await database().query("SELECT id,telegram_chat_id FROM application_conversations WHERE telegram_group_id=$1", [groupId])).rows[0])
      .toEqual({ id: before.id, telegram_chat_id: "-100456" });
    expect((await database().query("SELECT count(*)::int AS count FROM telegram_group_migrations")).rows[0].count).toBe(1);
  });

  it("refuses a separately registered target and rolls back", async () => {
    const { familyId, groupId } = await fixture();
    await database().query(`INSERT INTO telegram_groups(family_id,telegram_chat_id,title,type,message_mode)
      VALUES($1,'-100456','Other','external','addressed_only')`, [familyId]);
    await expect(reconcileVerifiedGroupMigration("901")).rejects.toThrow(/MIGRATION_CONFLICT/);
    expect((await database().query("SELECT telegram_chat_id FROM telegram_groups WHERE id=$1", [groupId])).rows[0].telegram_chat_id).toBe("-123");
    expect((await database().query("SELECT count(*)::int AS count FROM telegram_group_migrations")).rows[0].count).toBe(0);
  });

  it("moves only future schedules, preserving terminal history and existing pauses", async () => {
    const { familyId, groupId } = await fixture();
    const authorId = (await database().query(
      "INSERT INTO users(telegram_user_id,display_name) VALUES('migration-author','Author') RETURNING id",
    )).rows[0].id;
    for (const status of ["active", "paused", "completed", "failed"] as const) {
      await database().query(`INSERT INTO agent_schedules
        (family_id,author_user_id,group_id,scope,title,user_request,scenario_prompt,timezone,
         recurrence_kind,recurrence_interval,recurrence_anchor_local,next_run_at,
         telegram_chat_id,telegram_chat_type,status,last_error_code)
        VALUES($1,$2,$3,'family',$4::text,'Request','Scenario','UTC','once',1,now(),now()+interval '1 day',
          '-123','group',$4::text::agent_schedule_status,'previous')`, [familyId,authorId,groupId,status]);
    }
    await reconcileVerifiedGroupMigration("901");
    const rows = (await database().query(`SELECT title,status,telegram_chat_id,telegram_chat_type,last_error_code
      FROM agent_schedules ORDER BY title`)).rows;
    expect(rows).toEqual([
      { title: "active", status: "paused", telegram_chat_id: "-100456", telegram_chat_type: "supergroup", last_error_code: "AGENT_TELEGRAM_GROUP_MIGRATED" },
      { title: "completed", status: "completed", telegram_chat_id: "-123", telegram_chat_type: "group", last_error_code: "previous" },
      { title: "failed", status: "failed", telegram_chat_id: "-123", telegram_chat_type: "group", last_error_code: "previous" },
      { title: "paused", status: "paused", telegram_chat_id: "-100456", telegram_chat_type: "supergroup", last_error_code: "previous" },
    ]);
  });

  it("refuses leased reminders without changing registration or their delivery state", async () => {
    const { familyId, groupId } = await fixture();
    const authorId = (await database().query(
      "INSERT INTO users(telegram_user_id,display_name) VALUES('migration-author','Author') RETURNING id",
    )).rows[0].id;
    await database().query(`INSERT INTO reminders
      (family_id,author_user_id,group_id,scope,content,timezone,telegram_chat_id,
       recurrence_anchor_local,due_at,available_at,status,lease_token,lease_expires_at)
      VALUES($1,$2,$3,'family','Reminder','UTC','-123',now(),now(),now(),
        'leased',gen_random_uuid(),now()+interval '1 minute')`, [familyId,authorId,groupId]);
    await expect(reconcileVerifiedGroupMigration("901")).rejects.toThrow(/MIGRATION_BUSY/);
    expect((await database().query("SELECT telegram_chat_id FROM telegram_groups WHERE id=$1", [groupId])).rows[0].telegram_chat_id).toBe("-123");
    expect((await database().query("SELECT status,telegram_chat_id FROM reminders")).rows)
      .toEqual([{ status: "leased", telegram_chat_id: "-123" }]);
    expect((await database().query("SELECT count(*)::int AS count FROM telegram_group_migrations")).rows[0].count).toBe(0);
  });

  it("retires pending tasks and removes their old approvals and routes", async () => {
    const { familyId, groupId } = await fixture();
    const sessionId = (await database().query(`INSERT INTO conversation_sessions
      (thread_id,generation,family_id,group_id,scope,conversation_key,continuation_token,
       started_at,last_activity_at,kind,task_state,pending_operation)
      VALUES(gen_random_uuid(),0,$1,$2,'family','old-task','old-task',now(),now(),'task','pending',true)
      RETURNING id`, [familyId,groupId])).rows[0].id;
    await database().query(`INSERT INTO conversation_session_routes(base_continuation_token,session_id)
      VALUES('old-task',$1)`, [sessionId]);
    await database().query(`INSERT INTO telegram_hitl_approvals
      (application_session_id,eve_session_id,request_id,telegram_chat_id,telegram_chat_type,
       telegram_message_id,expected_telegram_user_id,callback_data,prompt_text,callback_options)
      VALUES($1,'eve-old','approval-old','-123','group',50,'owner',ARRAY['approve'],'Approve?', '[]'::jsonb)`, [sessionId]);
    await reconcileVerifiedGroupMigration("901");
    const row = (await database().query(`SELECT task_state,pending_operation,retired_at IS NOT NULL AS retired
      FROM conversation_sessions WHERE id=$1`, [sessionId])).rows[0];
    expect(row).toEqual({ task_state: "failed", pending_operation: false, retired: true });
    expect((await database().query("SELECT count(*)::int AS count FROM telegram_hitl_approvals")).rows[0].count).toBe(0);
    expect((await database().query("SELECT count(*)::int AS count FROM conversation_session_routes")).rows[0].count).toBe(0);
  });

  it.each([[false, false], [true, false], [false, true], [true, true]])(
    "resolves persisted provenance (wrote=%s, successor=%s)", async (wrote, successor) => {
    const { familyId, groupId } = await fixture();
    const conversationId = (await database().query(
      "SELECT id FROM application_conversations WHERE telegram_group_id=$1", [groupId],
    )).rows[0].id;
    const sessionId = await insertReviewSession(familyId, groupId, "review-migration");
    let sourceId = "";
    for (let sequence = 1; sequence <= 8; sequence++) {
      sourceId = (await insertReviewUserMessage({ conversationId, groupId, sequence })).id;
    }
    const batch = await memoryReviewRepository.prepareInteractiveTurn({
      applicationSessionId: sessionId, groupId, timelineEntryId: sourceId,
    });
    expect(batch).not.toBeNull();
    await memoryReviewRepository.bindEveTurn({
      applicationSessionId: sessionId, batchId: batch!.batchId,
      eveSessionId: "migration-review", eveTurnId: "review-turn",
    });
    if (successor) {
      for (let sequence = 9; sequence <= 16; sequence++) {
        sourceId = (await insertReviewUserMessage({ conversationId, groupId, sequence })).id;
      }
      const next = await memoryReviewRepository.prepareInteractiveTurn({
        applicationSessionId: sessionId, groupId, timelineEntryId: sourceId,
      });
      expect(next).not.toBeNull();
      await memoryReviewRepository.bindEveTurn({
        applicationSessionId: sessionId, batchId: next!.batchId,
        eveSessionId: "migration-review-successor", eveTurnId: "review-turn-successor",
      });
    }
    if (wrote) await database().query(`INSERT INTO memory_items_all
      (family_id,scope,kind,confirmation,sensitivity,content,source,operation_key)
      VALUES($1,'family','fact','model_high','normal','Preserved fact',
        'eve:migration-review:review-turn','migration-review-write')`, [familyId]);
    await reconcileVerifiedGroupMigration("901");
    expect((await database().query("SELECT status FROM memory_review_batches WHERE id=$1", [batch!.batchId])).rows)
      .toEqual(wrote ? [{ status: "completed" }] : []);
    expect((await database().query("SELECT processed_through_sequence::int AS cursor FROM memory_review_lanes WHERE conversation_id=$1", [conversationId])).rows)
      .toEqual([{ cursor: wrote ? 8 : 0 }]);
    expect((await database().query("SELECT count(*)::int AS count FROM memory_review_batch_sources")).rows[0].count).toBe(0);
    expect((await database().query("SELECT count(*)::int AS count FROM telegram_group_messages WHERE conversation_id=$1", [conversationId])).rows[0].count).toBe(successor ? 16 : 8);
    expect((await database().query("SELECT count(*)::int AS count FROM memory_items_all")).rows[0].count).toBe(wrote ? 1 : 0);
  });

  it("rejects a second registration or address rollback to the migrated old chat", async () => {
    const { familyId, groupId } = await fixture();
    await reconcileVerifiedGroupMigration("901");
    await expect(database().query(`INSERT INTO telegram_groups(family_id,telegram_chat_id,title,type,message_mode)
      VALUES($1,'-123','Duplicate','family_private','all')`, [familyId]))
      .rejects.toThrow(/AGENT_TELEGRAM_GROUP_ADDRESS_RETIRED/);
    await expect(database().query("UPDATE telegram_groups SET telegram_chat_id='-123' WHERE id=$1", [groupId]))
      .rejects.toThrow(/AGENT_TELEGRAM_GROUP_ADDRESS_RETIRED/);
    expect((await database().query("SELECT telegram_chat_id FROM telegram_groups WHERE family_id=$1", [familyId])).rows)
      .toEqual([{ telegram_chat_id: "-100456" }]);
  });

  it("keeps the retired address after removing the original trust zone", async () => {
    const { familyId, groupId } = await fixture();
    await reconcileVerifiedGroupMigration("901");
    await database().query("DELETE FROM telegram_groups WHERE id=$1", [groupId]);
    expect((await database().query("SELECT group_id,old_chat_id,new_chat_id FROM telegram_group_migrations")).rows)
      .toEqual([{ group_id: null, old_chat_id: "-123", new_chat_id: "-100456" }]);
    await expect(database().query(`INSERT INTO telegram_groups(family_id,telegram_chat_id,title,type,message_mode)
      VALUES($1,'-123','Old','family_private','all')`, [familyId]))
      .rejects.toThrow(/AGENT_TELEGRAM_GROUP_ADDRESS_RETIRED/);
    await expect(reconcileVerifiedGroupMigration("902")).rejects.toThrow(/MIGRATION_GROUP_MISSING/);
    expect((await database().query(`SELECT _retained_control FROM (${legacyBoundaryQuery("telegram_group_migrations")}) boundary`)).rows)
      .toEqual([{ _retained_control: true }]);
    // The new transport can receive a new trust zone; it must not inherit the deleted identity.
    const recreated = (await database().query(`INSERT INTO telegram_groups(family_id,telegram_chat_id,title,type,message_mode)
      VALUES($1,'-100456','New boundary','external','addressed_only') RETURNING id`, [familyId])).rows[0].id;
    expect(recreated).not.toBe(groupId);
    await database().query("DELETE FROM families WHERE id=$1", [familyId]);
    expect((await database().query("SELECT count(*)::int AS count FROM telegram_group_migrations")).rows[0].count).toBe(0);
  });

  it("retires late old-chat text, voice and callbacks before they can be claimed", async () => {
    await fixture();
    const messages = [
      { update_id: 903, message: { chat: { id: -123, type: "group" }, text: "Late text" } },
      { update_id: 904, message: { chat: { id: -123, type: "group" }, voice: { file_id: "old-voice" } } },
      { update_id: 905, callback_query: { id: "late-callback", message: { chat: { id: -123, type: "group" } }, data: "approve" } },
      { update_id: 906, message: { chat: { id: -100456, type: "supergroup" }, text: "Current text" } },
    ];
    for (const payload of messages) await telegramIngressRepository.enqueue({
      continuationKey: payload.update_id === 906 ? "telegram:-100456" : "telegram:-123",
      updateId: String(payload.update_id), payload,
      ...(payload.update_id === 904 ? { voice: { fileId: "old-voice" } } : {}),
    });
    await reconcileVerifiedGroupMigration("901");
    const paired = await telegramIngressRepository.claimNext(60000);
    expect(paired?.updateId).toBe("902");
    await telegramIngressRepository.complete(paired!.updateId, paired!.leaseToken);
    expect((await telegramIngressRepository.claimNext(60000))?.updateId).toBe("906");
    const retired = (await database().query(`SELECT status,dispatch_started_at,voice_transcription_started_at,
      last_error_code FROM telegram_ingress_updates WHERE update_id IN (901,903,904,905) ORDER BY update_id`)).rows;
    expect(retired).toHaveLength(4);
    for (const row of retired) expect(row).toEqual({
      status: "completed", dispatch_started_at: null, voice_transcription_started_at: null,
      last_error_code: "AGENT_TELEGRAM_GROUP_ADDRESS_RETIRED",
    });
  });

  it("refuses migration while the old transport has a leased update", async () => {
    await fixture();
    const old = await telegramIngressRepository.claimNext(60000);
    expect(old?.updateId).toBe("901");
    await expect(reconcileVerifiedGroupMigration("902")).rejects.toThrow(/MIGRATION_BUSY/);
    expect((await database().query("SELECT status,lease_token::text FROM telegram_ingress_updates WHERE update_id=901")).rows)
      .toEqual([{ status: "processing", lease_token: old!.leaseToken }]);
    await telegramIngressRepository.complete(old!.updateId, old!.leaseToken);
    await expect(reconcileVerifiedGroupMigration("902")).resolves.toMatchObject({ replayed: false });
  });

  it("requires an existing service event instead of trusting an arbitrary requested mapping", async () => {
    await expect(reconcileVerifiedGroupMigration("999")).rejects.toThrow(/MIGRATION_SOURCE_MISSING/);
  });
});
