/**
 * Durable Telegram HITL approval repository integration tests.
 *
 * Constructs covered:
 * - `telegramHitlApprovalRepository.register`: binds a rendered request to one Telegram user.
 * - `claimCallback`: atomically rejects foreign, stale, and repeated callback attempts.
 * - Pending approvals survive the Eve turn that pauses for user input.
 * - `authorizeReply`: atomically protects and consumes accepted text replies.
 * - Consumed prompts become ordinary ancestry for any later author without weakening pending binds.
 * - Owner-only external approvals recheck the current owner role before resuming Eve.
 * - Several requests of one step share one prompt row set and are consumed by a single claim.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { sessionRepository } from "../sessions/session-repository.js";
import { telegramHitlApprovalRepository } from "./approval-repository.js";
import { bindGroupToSpace } from "../spaces/two-space-fixture.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;
const OWNER_TELEGRAM_ID = "hitl-owner";

async function fixture(
  options: {
    kind?: "question" | "tool-approval";
    scoped?: boolean;
    messageMode?: "addressed_only" | "owner_only";
    scope?: "family" | "group";
    type?: "external" | "family_private";
  } = {},
) {
  const groupType = options.type ?? "family_private";
  const messageMode = options.messageMode ?? "addressed_only";
  const scope = options.scope ?? "family";
  const family = await database().query<{ id: string }>("INSERT INTO families (name) VALUES ('HITL') RETURNING id");
  const owner = await database().query<{ id: string }>(
    `INSERT INTO users (telegram_user_id, display_name)
     VALUES ($1, 'Владелец') RETURNING id`,
    [OWNER_TELEGRAM_ID],
  );
  await database().query(
    `INSERT INTO family_memberships (family_id, user_id, role)
     VALUES ($1, $2, 'owner')`,
    [family.rows[0]!.id, owner.rows[0]!.id],
  );
  const group = await database().query<{ id: string }>(
    `INSERT INTO telegram_groups
       (family_id, telegram_chat_id, title, type, message_mode)
     VALUES ($1, '-1001', 'Семья', $2, $3)
      RETURNING id`,
    [family.rows[0]!.id, groupType, messageMode],
  );
  let spaceId: string | undefined;
  if (options.scoped) {
    spaceId = (await database().query("INSERT INTO spaces(family_id,kind,title) VALUES($1,'shared','Pair') RETURNING id", [family.rows[0]!.id])).rows[0].id;
    await database().query("INSERT INTO space_memberships(family_id,space_id,user_id,role,state) VALUES($1,$2,$3,'manager','active')", [family.rows[0]!.id,spaceId,owner.rows[0]!.id]);
    await database().query("UPDATE spaces SET state='active' WHERE id=$1", [spaceId]);
    await bindGroupToSpace(database(), family.rows[0]!.id, group.rows[0]!.id, spaceId!);
  }
  const session = await sessionRepository.prepareTurn({
    ...(spaceId ? { spaceContext: { familyId: family.rows[0]!.id, userId: owner.rows[0]!.id, spaceId,
      chat: { type: "supergroup" as const, groupId: group.rows[0]!.id } } } : {}),
    baseContinuationToken: "-1001:55:77",
    kind: "canonical",
    telegramForumTopicId: null,
    familyId: family.rows[0]!.id,
    groupId: group.rows[0]!.id,
    now: new Date("2026-07-13T12:00:00.000Z"),
    scope,
    userId: null,
  });
  await sessionRepository.bindEveSession(session.id, "wrun_hitl");
  await sessionRepository.parkSession({
    applicationSessionId: session.id,
    pendingRequestId: "approval-request-1",
    requesterTelegramUserId: OWNER_TELEGRAM_ID,
    requesterUserId: owner.rows[0]!.id,
  });
  await sessionRepository.registerRouteAlias(session.id, "-1001:55:88");
  await telegramHitlApprovalRepository.register({
    applicationSessionId: session.id,
    kind: options.kind ?? "tool-approval",
    callbackData: ["eve:0", "eve:1"],
    callbackOptions: [
      { callbackData: "eve:0", label: "Да, подтвердить", optionId: "approve" },
      { callbackData: "eve:1", label: "Нет, отклонить", optionId: "deny" },
    ],
    eveSessionId: "wrun_hitl",
    requestId: "approval-request-1",
    promptText: "Подтвердите тестовое действие",
    telegramChatId: "-1001",
    telegramChatType: "supergroup",
    telegramMessageId: "88",
    telegramMessageThreadId: "55",
    telegramUserId: OWNER_TELEGRAM_ID,
    toolCallId: "call-1",
    toolInputHash: "a".repeat(64),
    toolName: "test_tool",
  });
  return { ownerId: owner.rows[0]!.id, sessionId: session.id, spaceId };
}

describeWithDatabase("Telegram HITL approval repository", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE telegram_hitl_approvals, conversation_session_routes, conversation_sessions, telegram_groups, family_memberships, users, families CASCADE");
  });
  afterAll(async () => closeDatabase());

  for (const kind of ["question", "tool-approval"] as const) {
    it(`rejects a ${kind} answer after its space binding is paused`, async () => {
      const current = await fixture({ scoped: true, kind });
      await database().query("UPDATE space_bindings SET state='paused' WHERE space_id=$1", [current.spaceId]);
      const answer = { baseContinuationToken: "-1001:55:88", telegramChatId: "-1001",
        telegramMessageId: "88", telegramUserId: OWNER_TELEGRAM_ID };
      if (kind === "question") await expect(telegramHitlApprovalRepository.authorizeReply(answer)).resolves.toBe("expired");
      else await expect(telegramHitlApprovalRepository.claimCallback({ ...answer, callbackData: "eve:0" })).resolves.toEqual({ status: "expired" });
      expect((await database().query("SELECT consumed_at FROM telegram_hitl_approvals WHERE application_session_id=$1", [current.sessionId])).rows[0].consumed_at).toBeNull();
    });
  }

  it("waits for an in-flight audience change and rejects its old callback", async () => {
    const current = await fixture({ scoped: true });
    const writer = await database().connect();
    let claim: ReturnType<typeof telegramHitlApprovalRepository.claimCallback> | undefined;
    try {
      await writer.query("BEGIN");
      const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await writer.query("SELECT id FROM spaces WHERE id=$1 FOR UPDATE", [current.spaceId]);
      claim = telegramHitlApprovalRepository.claimCallback({ baseContinuationToken: "-1001:55:88",
        telegramChatId: "-1001", telegramMessageId: "88", telegramUserId: OWNER_TELEGRAM_ID, callbackData: "eve:0" });
      // Observe the actual database wait, not merely elapsed time on a promise.
      await expect.poll(async () => (await database().query(
        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting", [pid],
      )).rows[0].waiting).toBe(true);
      await writer.query("UPDATE space_memberships SET state='revoked' WHERE space_id=$1 AND user_id=$2", [current.spaceId,current.ownerId]);
      await writer.query("COMMIT");
      await expect(claim).resolves.toEqual({ status: "expired" });
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
      await claim;
    }
  });

  for (const change of ["membership", "binding"] as const) {
    it(`rejects accepted tool evidence after ${change} changes before execution`, async () => {
      const current = await fixture({ scoped: true });
      await expect(telegramHitlApprovalRepository.claimCallback({ baseContinuationToken: "-1001:55:88",
        telegramChatId: "-1001", telegramMessageId: "88", telegramUserId: OWNER_TELEGRAM_ID, callbackData: "eve:0" }))
        .resolves.toMatchObject({ status: "authorized" });
      const exact = { applicationSessionId: current.sessionId, eveSessionId: "wrun_hitl", telegramUserId: OWNER_TELEGRAM_ID,
        toolCallId: "call-1", toolInputHash: "a".repeat(64), toolName: "test_tool" };
      await expect(telegramHitlApprovalRepository.requireToolExecutionApproval(exact)).resolves.toBeUndefined();
      if (change === "membership") await database().query("UPDATE space_memberships SET state='revoked' WHERE space_id=$1", [current.spaceId]);
      else await database().query("UPDATE space_bindings SET state='paused' WHERE space_id=$1", [current.spaceId]);
      await expect(telegramHitlApprovalRepository.requireToolExecutionApproval(exact))
        .rejects.toMatchObject({ code: "AGENT_TOOL_APPROVAL_EVIDENCE_INVALID" });
    });
  }

  it("preserves the verified space policy when resuming a current callback", async () => {
    const current = await fixture({ scoped: true });
    const policy = (await database().query("SELECT policy_version FROM spaces WHERE id=$1", [current.spaceId])).rows[0].policy_version;
    await expect(telegramHitlApprovalRepository.claimCallback({ baseContinuationToken: "-1001:55:88", telegramChatId: "-1001",
      telegramMessageId: "88", telegramUserId: OWNER_TELEGRAM_ID, callbackData: "eve:0" }))
      .resolves.toMatchObject({ status: "authorized", auth: { attributes: { spaceId: current.spaceId, spacePolicyVersion: String(policy) } } });
  });

  it("rejects another group member without consuming the initiator's approval", async () => {
    const current = await fixture();

    await expect(
      telegramHitlApprovalRepository.claimCallback({
        baseContinuationToken: "-1001:55:88",
        callbackData: "eve:0",
        telegramChatId: "-1001",
        telegramMessageId: "88",
        telegramUserId: "202",
      }),
    ).resolves.toEqual({ status: "forbidden" });

    await expect(
      telegramHitlApprovalRepository.claimCallback({
        baseContinuationToken: "-1001:55:88",
        callbackData: "eve:0",
        telegramChatId: "-1001",
        telegramMessageId: "88",
        telegramUserId: OWNER_TELEGRAM_ID,
      }),
    ).resolves.toMatchObject({
      auth: {
        attributes: {
          applicationSessionId: current.sessionId,
          familyId: expect.any(String),
          groupId: expect.any(String),
          groupType: "family_private",
          memoryScopes: ["family"],
          role: "owner",
          telegramActorId: OWNER_TELEGRAM_ID,
          telegramActorKind: "telegram_user",
          telegramUserId: OWNER_TELEGRAM_ID,
        },
        authenticator: "telegram",
        principalId: current.ownerId,
        principalType: "user",
      },
      promptText: "Подтвердите тестовое действие",
      selectedOptionId: "approve",
      selectedOptionLabel: "Да, подтвердить",
      status: "authorized",
    });
  });

  it("expires a callback after its first atomic claim", async () => {
    const current = await fixture();
    const input = {
      callbackData: "eve:1",
      baseContinuationToken: "-1001:55:88",
      telegramChatId: "-1001",
      telegramMessageId: "88",
      telegramUserId: OWNER_TELEGRAM_ID,
    };

    await expect(telegramHitlApprovalRepository.claimCallback(input)).resolves.toMatchObject({
      selectedOptionId: "deny",
      selectedOptionLabel: "Нет, отклонить",
      status: "authorized",
    });
    await expect(telegramHitlApprovalRepository.claimCallback(input)).resolves.toEqual({ status: "expired" });
    await expect(
      telegramHitlApprovalRepository.requireToolExecutionApproval({
        applicationSessionId: current.sessionId,
        eveSessionId: "wrun_hitl",
        telegramUserId: OWNER_TELEGRAM_ID,
        toolCallId: "call-1",
        toolInputHash: "a".repeat(64),
        toolName: "test_tool",
      }),
    ).rejects.toThrowError(/AGENT_TOOL_APPROVAL_EVIDENCE_INVALID/u);
  });

  it("authorizes execution only for the exact consumed identity-bound tool call", async () => {
    const current = await fixture();
    await telegramHitlApprovalRepository.claimCallback({
      baseContinuationToken: "-1001:55:88",
      callbackData: "eve:0",
      telegramChatId: "-1001",
      telegramMessageId: "88",
      telegramUserId: OWNER_TELEGRAM_ID,
    });

    const exact = {
      applicationSessionId: current.sessionId,
      eveSessionId: "wrun_hitl",
      telegramUserId: OWNER_TELEGRAM_ID,
      toolCallId: "call-1",
      toolInputHash: "a".repeat(64),
      toolName: "test_tool",
    };
    await expect(telegramHitlApprovalRepository.requireToolExecutionApproval(exact)).resolves.toBeUndefined();
    await expect(
      telegramHitlApprovalRepository.requireToolExecutionApproval({
        ...exact,
        toolInputHash: "f".repeat(64),
      }),
    ).rejects.toThrowError(/AGENT_TOOL_APPROVAL_EVIDENCE_INVALID/u);
    await expect(
      telegramHitlApprovalRepository.requireToolExecutionApproval({
        ...exact,
        telegramUserId: "202",
      }),
    ).rejects.toThrowError(/AGENT_TOOL_APPROVAL_EVIDENCE_INVALID/u);
  });

  it("carries the conversation and timeline identity of the turn into the resumed auth", async () => {
    const { sessionId } = await fixture();
    await telegramHitlApprovalRepository.register({
      applicationSessionId: sessionId,
      kind: "tool-approval",
      callbackData: ["eve:0", "eve:1"],
      callbackOptions: [
        { callbackData: "eve:0", label: "Да", optionId: "approve" },
        { callbackData: "eve:1", label: "Нет", optionId: "deny" },
      ],
      eveSessionId: "wrun_hitl",
      requestId: "approval-request-1",
      promptText: "Подтвердите тестовое действие",
      telegramChatId: "-1001",
      telegramChatType: "supergroup",
      telegramConversationId: "00000000-0000-4000-8000-000000000077",
      telegramMessageId: "88",
      telegramMessageThreadId: "55",
      telegramTimelineEntryId: "00000000-0000-4000-8000-000000000078",
      telegramUserId: OWNER_TELEGRAM_ID,
      toolCallId: "call-1",
      toolInputHash: "a".repeat(64),
      toolName: "test_tool",
    });

    // manage_memory corrections and thread lifecycle read the source from these attributes; the
    // resumed turn used to lose them and reject every correction after an approval.
    const claimed = await telegramHitlApprovalRepository.claimCallback({
      baseContinuationToken: "-1001:55:88",
      callbackData: "eve:0",
      telegramChatId: "-1001",
      telegramMessageId: "88",
      telegramUserId: OWNER_TELEGRAM_ID,
    });
    expect(claimed).toMatchObject({
      auth: { attributes: {
        telegramConversationId: "00000000-0000-4000-8000-000000000077",
        telegramTimelineEntryId: "00000000-0000-4000-8000-000000000078",
      } },
      status: "authorized",
    });
  });

  it("keeps a callback claimable after the Eve turn pauses for approval", async () => {
    const current = await fixture();

    await expect(telegramHitlApprovalRepository.hasPendingForSession(current.sessionId, "wrun_hitl")).resolves.toBe(true);
    await expect(sessionRepository.recordTurnCompleted(current.sessionId, "wrun_hitl", true)).resolves.toBe("recorded");
    await expect(
      telegramHitlApprovalRepository.claimCallback({
        baseContinuationToken: "-1001:55:88",
        callbackData: "eve:0",
        telegramChatId: "-1001",
        telegramMessageId: "88",
        telegramUserId: OWNER_TELEGRAM_ID,
      }),
    ).resolves.toMatchObject({ status: "authorized" });
    await expect(telegramHitlApprovalRepository.hasPendingForSession(current.sessionId, "wrun_hitl")).resolves.toBe(false);
  });

  it("keeps other simultaneously rendered requests pending", async () => {
    const current = await fixture();
    await sessionRepository.registerRouteAlias(current.sessionId, "-1001:55:89");
    await telegramHitlApprovalRepository.register({
      applicationSessionId: current.sessionId,
      kind: "tool-approval" as const,
      callbackData: ["eve:2", "eve:3"],
      callbackOptions: [
        {
          callbackData: "eve:2",
          label: "Да, подтвердить",
          optionId: "approve",
        },
        { callbackData: "eve:3", label: "Нет, отклонить", optionId: "deny" },
      ],
      eveSessionId: "wrun_hitl",
      requestId: "approval-request-2",
      promptText: "Подтвердите второе действие",
      telegramChatId: "-1001",
      telegramChatType: "supergroup",
      telegramMessageId: "89",
      telegramMessageThreadId: "55",
      telegramUserId: OWNER_TELEGRAM_ID,
      toolCallId: "call-2",
      toolInputHash: "b".repeat(64),
      toolName: "test_tool",
    });

    await expect(
      telegramHitlApprovalRepository.claimCallback({
        baseContinuationToken: "-1001:55:88",
        callbackData: "eve:0",
        telegramChatId: "-1001",
        telegramMessageId: "88",
        telegramUserId: OWNER_TELEGRAM_ID,
      }),
    ).resolves.toMatchObject({ status: "authorized" });
    await expect(
      telegramHitlApprovalRepository.claimCallback({
        baseContinuationToken: "-1001:55:89",
        callbackData: "eve:2",
        telegramChatId: "-1001",
        telegramMessageId: "89",
        telegramUserId: OWNER_TELEGRAM_ID,
      }),
    ).resolves.toMatchObject({ status: "authorized" });
  });

  it("consumes every request rendered by one shared prompt in a single claim", async () => {
    const current = await fixture();
    // The second request of the same step shares message 88 and its callbacks.
    await telegramHitlApprovalRepository.register({
      applicationSessionId: current.sessionId,
      kind: "tool-approval" as const,
      callbackData: ["eve:0", "eve:1"],
      callbackOptions: [
        { callbackData: "eve:0", label: "Да, подтвердить все", optionId: "approve" },
        { callbackData: "eve:1", label: "Нет, отменить все", optionId: "cancel" },
      ],
      eveSessionId: "wrun_hitl",
      requestId: "approval-request-2",
      promptText: "Подтвердите тестовое действие",
      telegramChatId: "-1001",
      telegramChatType: "supergroup",
      telegramMessageId: "88",
      telegramMessageThreadId: "55",
      telegramUserId: OWNER_TELEGRAM_ID,
      toolCallId: "call-2",
      toolInputHash: "b".repeat(64),
      toolName: "test_tool",
    });

    const claim = await telegramHitlApprovalRepository.claimCallback({
      baseContinuationToken: "-1001:55:88",
      callbackData: "eve:0",
      telegramChatId: "-1001",
      telegramMessageId: "88",
      telegramUserId: OWNER_TELEGRAM_ID,
    });

    expect(claim).toMatchObject({
      requestIds: ["approval-request-1", "approval-request-2"],
      selectedOptionId: "approve",
      status: "authorized",
    });
    await expect(telegramHitlApprovalRepository.requireToolExecutionApproval({
      applicationSessionId: current.sessionId,
      eveSessionId: "wrun_hitl",
      telegramUserId: OWNER_TELEGRAM_ID,
      toolCallId: "call-2",
      toolInputHash: "b".repeat(64),
      toolName: "test_tool",
    })).resolves.toBeUndefined();
    await expect(telegramHitlApprovalRepository.hasPendingForSession(current.sessionId, "wrun_hitl"))
      .resolves.toBe(false);
    // The prompt is spent as a whole: a second tap cannot answer the other request alone.
    await expect(
      telegramHitlApprovalRepository.claimCallback({
        baseContinuationToken: "-1001:55:88",
        callbackData: "eve:1",
        telegramChatId: "-1001",
        telegramMessageId: "88",
        telegramUserId: OWNER_TELEGRAM_ID,
      }),
    ).resolves.toEqual({ status: "expired" });
  });

  it("clears only approvals owned by the completed Eve root", async () => {
    const current = await fixture();
    await telegramHitlApprovalRepository.register({
      applicationSessionId: current.sessionId,
      kind: "tool-approval" as const,
      callbackData: ["eve:2"],
      callbackOptions: [
        {
          callbackData: "eve:2",
          label: "Да, подтвердить",
          optionId: "approve",
        },
      ],
      eveSessionId: "wrun_hitl_new",
      requestId: "approval-request-new-root",
      promptText: "Подтвердите действие нового запуска",
      telegramChatId: "-1001",
      telegramChatType: "supergroup",
      telegramMessageId: "90",
      telegramMessageThreadId: "55",
      telegramUserId: OWNER_TELEGRAM_ID,
      toolCallId: "call-new-root",
      toolInputHash: "c".repeat(64),
      toolName: "test_tool",
    });

    await telegramHitlApprovalRepository.clearForEveSession(current.sessionId, "wrun_hitl");

    await expect(database().query<{ eve_session_id: string }>("SELECT eve_session_id FROM telegram_hitl_approvals WHERE application_session_id = $1", [current.sessionId])).resolves.toMatchObject({
      rows: [{ eve_session_id: "wrun_hitl_new" }],
    });
  });

  it("rechecks active family membership before resuming Eve", async () => {
    const current = await fixture();
    await database().query("DELETE FROM family_memberships WHERE user_id = $1", [current.ownerId]);

    await expect(
      telegramHitlApprovalRepository.claimCallback({
        baseContinuationToken: "-1001:55:88",
        callbackData: "eve:0",
        telegramChatId: "-1001",
        telegramMessageId: "88",
        telegramUserId: OWNER_TELEGRAM_ID,
      }),
    ).resolves.toEqual({ status: "forbidden" });
  });

  it("allows the current owner to resume an owner-only external approval", async () => {
    await fixture({
      messageMode: "owner_only",
      scope: "group",
      type: "external",
    });

    await expect(
      telegramHitlApprovalRepository.claimCallback({
        baseContinuationToken: "-1001:55:88",
        callbackData: "eve:0",
        telegramChatId: "-1001",
        telegramMessageId: "88",
        telegramUserId: OWNER_TELEGRAM_ID,
      }),
    ).resolves.toMatchObject({ status: "authorized" });
  });

  it("rejects an owner-only external approval after owner-role revocation", async () => {
    const current = await fixture({
      messageMode: "owner_only",
      scope: "group",
      type: "external",
    });
    await database().query("UPDATE family_memberships SET role = 'member' WHERE user_id = $1", [current.ownerId]);

    await expect(
      telegramHitlApprovalRepository.claimCallback({
        baseContinuationToken: "-1001:55:88",
        callbackData: "eve:0",
        telegramChatId: "-1001",
        telegramMessageId: "88",
        telegramUserId: OWNER_TELEGRAM_ID,
      }),
    ).resolves.toEqual({ status: "forbidden" });
  });

  it("leaves a button approval untouched by a text reply", async () => {
    await fixture();

    // "да" typed under a button prompt is ordinary conversation: Eve does not turn it into a
    // button decision, so consuming the row here would only kill the buttons.
    await expect(
      telegramHitlApprovalRepository.authorizeReply({
        baseContinuationToken: "-1001:55:88",
        telegramChatId: "-1001",
        telegramMessageId: "88",
        telegramUserId: OWNER_TELEGRAM_ID,
      }),
    ).resolves.toBe("not_applicable");
    await expect(database().query(
      "SELECT consumed_at FROM telegram_hitl_approvals WHERE telegram_message_id = 88",
    )).resolves.toMatchObject({ rows: [{ consumed_at: null }] });
    await expect(
      telegramHitlApprovalRepository.claimCallback({
        baseContinuationToken: "-1001:55:88",
        callbackData: "eve:0",
        telegramChatId: "-1001",
        telegramMessageId: "88",
        telegramUserId: OWNER_TELEGRAM_ID,
      }),
    ).resolves.toMatchObject({ status: "authorized" });
  });

  it("protects and atomically consumes a text reply from the expected identity", async () => {
    await fixture({ kind: "question" });

    await expect(
      telegramHitlApprovalRepository.authorizeReply({
        baseContinuationToken: "-1001:55:88",
        telegramChatId: "-1001",
        telegramMessageId: "88",
        telegramUserId: "202",
      }),
    ).resolves.toBe("forbidden");
    await expect(
      telegramHitlApprovalRepository.authorizeReply({
        baseContinuationToken: "-1001:55:88",
        telegramChatId: "-1001",
        telegramMessageId: "88",
        telegramUserId: OWNER_TELEGRAM_ID,
      }),
    ).resolves.toBe("authorized");
    await expect(sessionRepository.hasRoute("-1001:55:88")).resolves.toBe(false);
    await expect(
      telegramHitlApprovalRepository.authorizeReply({
        baseContinuationToken: "-1001:55:88",
        telegramChatId: "-1001",
        telegramMessageId: "88",
        telegramUserId: "202",
      }),
    ).resolves.toBe("not_applicable");
    await expect(
      telegramHitlApprovalRepository.authorizeReply({
        baseContinuationToken: "-1001:55:999",
        telegramChatId: "-1001",
        telegramMessageId: "999",
        telegramUserId: OWNER_TELEGRAM_ID,
      }),
    ).resolves.toBe("not_applicable");
  });

  it("treats a removed ordinary alias as canonical ancestry while a task awaits approval", async () => {
    await fixture();

    await expect(
      telegramHitlApprovalRepository.authorizeReply({
        baseContinuationToken: "-1001:55:77",
        telegramChatId: "-1001",
        telegramMessageId: "77",
        telegramUserId: "202",
      }),
    ).resolves.toBe("not_applicable");
  });

  it("fails closed when the route is pending but approval registration is missing", async () => {
    await fixture();
    await database().query("DELETE FROM telegram_hitl_approvals");

    await expect(
      telegramHitlApprovalRepository.authorizeReply({
        baseContinuationToken: "-1001:55:88",
        telegramChatId: "-1001",
        telegramMessageId: "88",
        telegramUserId: "202",
      }),
    ).resolves.toBe("expired");
  });
});
