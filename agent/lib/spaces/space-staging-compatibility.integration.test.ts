/**
 * Миграции 103-106 применяются к живой установке раньше, чем ingress начинает выдавать контекст
 * пространства. Бэкфилл 104 проставляет `space_id` каждой строке, поэтому признаком привязки может
 * быть только `space_policy_version`: миграция 106 намеренно оставляет его пустым у прежней истории.
 *
 * Проверяется ровно то состояние, в котором окажется прод сразу после выпуска: данные связаны,
 * режим ещё прежний. Обычный ход и любое висящее подтверждение обязаны продолжать работать.
 */
import { readFile } from "node:fs/promises";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { sessionRepository } from "../sessions/session-repository.js";
import { telegramHitlApprovalRepository } from "../telegram-hitl/approval-repository.js";
import { approvalTimeoutRepository } from "../telegram-hitl/approval-timeout-repository.js";
import { backfillSpaceRecords104 } from "../../../scripts/migration-data/space-records-104.ts";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const dbDescribe = enabled ? describe : describe.skip;

const OWNER_TELEGRAM_ID = "staging-owner";
const GROUP_CHAT_ID = "-9001";
const PRIVATE_CHAT_ID = "9002";
const PRIVATE_MESSAGE_ID = "88";
const GROUP_TOKEN = `${GROUP_CHAT_ID}:55:77`;
const PRIVATE_TOKEN = `${PRIVATE_CHAT_ID}::`;
const PRIVATE_REPLY_ROUTE = `${PRIVATE_CHAT_ID}::${PRIVATE_MESSAGE_ID}`;
const EVE_SESSION = "wrun_staging_private";
const TURN_AT = new Date("2026-09-11T12:00:00.000Z");

let familyId: string;
let ownerId: string;
let privateSessionId: string;

async function applyLegacySnapshot(): Promise<void> {
  const sql = await readFile("migrations/103_spaces.sql", "utf8");
  await database().query(sql.slice(sql.indexOf("-- LEGACY_AUDIENCE_SNAPSHOT:")));
}

async function applyRecordBackfill(): Promise<void> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await backfillSpaceRecords104(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function prepareGroupTurn() {
  return sessionRepository.prepareTurn({
    baseContinuationToken: GROUP_TOKEN,
    familyId,
    groupId: (await database().query<{ id: string }>(
      "SELECT id FROM telegram_groups WHERE family_id=$1",
      [familyId],
    )).rows[0]!.id,
    kind: "canonical",
    now: TURN_AT,
    scope: "family",
    telegramForumTopicId: null,
    userId: null,
  });
}

async function parkPrivateApproval(kind: "question" | "tool-approval"): Promise<void> {
  await sessionRepository.parkSession({
    applicationSessionId: privateSessionId,
    pendingRequestId: "staging-request-1",
    requesterTelegramUserId: OWNER_TELEGRAM_ID,
    requesterUserId: ownerId,
  });
  await telegramHitlApprovalRepository.register({
    applicationSessionId: privateSessionId,
    callbackData: ["eve:0", "eve:1"],
    callbackOptions: [
      { callbackData: "eve:0", label: "Да, подтвердить", optionId: "approve" },
      { callbackData: "eve:1", label: "Нет, отклонить", optionId: "deny" },
    ],
    eveSessionId: EVE_SESSION,
    kind,
    promptText: "Подтвердите тестовое действие",
    requestId: "staging-request-1",
    telegramChatId: PRIVATE_CHAT_ID,
    telegramChatType: "private",
    telegramMessageId: PRIVATE_MESSAGE_ID,
    telegramMessageThreadId: null,
    telegramUserId: OWNER_TELEGRAM_ID,
    toolCallId: "call-1",
    toolInputHash: "a".repeat(64),
    toolName: "test_tool",
  });
}

dbDescribe("staged spaces stay invisible until the runtime switches", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE families,users,telegram_ingress_updates,image_generation_operations,workspace_deletion_jobs,workspace_operations CASCADE",
    );
    familyId = (await database().query<{ id: string }>(
      "INSERT INTO families(name) VALUES('Staging family') RETURNING id",
    )).rows[0]!.id;
    ownerId = (await database().query<{ id: string }>(
      "INSERT INTO users(telegram_user_id,display_name) VALUES($1,'Владелец') RETURNING id",
      [OWNER_TELEGRAM_ID],
    )).rows[0]!.id;
    await database().query(
      "INSERT INTO family_memberships(family_id,user_id,role) VALUES($1,$2,'owner')",
      [familyId, ownerId],
    );
    await database().query(
      `INSERT INTO telegram_groups(family_id,telegram_chat_id,title,type,message_mode)
       VALUES($1,$2,'Семья','family_private','addressed_only')`,
      [familyId, GROUP_CHAT_ID],
    );
    await applyLegacySnapshot();
    await prepareGroupTurn();
    privateSessionId = (await sessionRepository.prepareTurn({
      baseContinuationToken: PRIVATE_TOKEN,
      familyId,
      groupId: null,
      kind: "canonical",
      now: TURN_AT,
      scope: "personal",
      telegramForumTopicId: null,
      userId: ownerId,
    })).id;
    await sessionRepository.bindEveSession(privateSessionId, EVE_SESSION);
    await sessionRepository.registerRouteAlias(privateSessionId, PRIVATE_REPLY_ROUTE);
  });
  afterAll(closeDatabase);

  it("binds existing sessions without granting them a policy version", async () => {
    await applyRecordBackfill();
    const rows = (await database().query<{ space_id: string | null; space_policy_version: number | null }>(
      "SELECT space_id,space_policy_version FROM conversation_sessions ORDER BY started_at",
    )).rows;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.space_id !== null)).toBe(true);
    expect(rows.every((row) => row.space_policy_version === null)).toBe(true);
  });

  it("continues a group conversation after the backfill", async () => {
    const before = await prepareGroupTurn();
    await applyRecordBackfill();
    const resumed = await prepareGroupTurn();
    expect(resumed.id).toBe(before.id);
    expect(resumed.rotated).toBe(false);
  });

  it("still accepts a pending approval button after the backfill", async () => {
    await parkPrivateApproval("tool-approval");
    await applyRecordBackfill();
    const claim = await telegramHitlApprovalRepository.claimCallback({
      baseContinuationToken: PRIVATE_REPLY_ROUTE,
      callbackData: "eve:0",
      telegramChatId: PRIVATE_CHAT_ID,
      telegramMessageId: PRIVATE_MESSAGE_ID,
      telegramUserId: OWNER_TELEGRAM_ID,
    });
    expect(claim.status).toBe("authorized");
  });

  it("still accepts a text reply to a pending question after the backfill", async () => {
    await parkPrivateApproval("question");
    await applyRecordBackfill();
    await expect(telegramHitlApprovalRepository.authorizeReply({
      baseContinuationToken: PRIVATE_REPLY_ROUTE,
      telegramChatId: PRIVATE_CHAT_ID,
      telegramMessageId: PRIVATE_MESSAGE_ID,
      telegramUserId: OWNER_TELEGRAM_ID,
    })).resolves.toBe("authorized");
  });

  it("still honours consented tool evidence after the backfill", async () => {
    await parkPrivateApproval("tool-approval");
    await telegramHitlApprovalRepository.claimCallback({
      baseContinuationToken: PRIVATE_REPLY_ROUTE,
      callbackData: "eve:0",
      telegramChatId: PRIVATE_CHAT_ID,
      telegramMessageId: PRIVATE_MESSAGE_ID,
      telegramUserId: OWNER_TELEGRAM_ID,
    });
    await applyRecordBackfill();
    await expect(telegramHitlApprovalRepository.requireToolExecutionApproval({
      applicationSessionId: privateSessionId,
      eveSessionId: EVE_SESSION,
      telegramUserId: OWNER_TELEGRAM_ID,
      toolCallId: "call-1",
      toolInputHash: "a".repeat(64),
      toolName: "test_tool",
    })).resolves.toBeUndefined();
  });

  it("still cancels an unanswered approval on timeout after the backfill", async () => {
    await parkPrivateApproval("tool-approval");
    await applyRecordBackfill();
    const claims = await approvalTimeoutRepository.claimExpired(
      new Date(Date.now() + 10 * 60 * 1000),
      5 * 60 * 1000,
    );
    expect(claims.map((claim) => claim.requestId)).toEqual(["staging-request-1"]);
  });
});
