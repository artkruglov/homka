/**
 * Owner-requested Telegram group context rotation PostgreSQL tests.
 *
 * Constructs covered:
 * - All active canonical sessions in one registered group receive a rotation request.
 * - Pending tasks and sessions belonging to another group remain unchanged.
 * - The next turn in each affected topic creates a fresh canonical generation.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { SESSION_GROUP_ROTATION_LOCK_HASH_SEED } from "../config.js";
import { closeDatabase, database } from "./database.js";
import { sessionRepository } from "./sessions/session-repository.js";
import { telegramGroupAdministrationRepository } from "./telegram-group-administration-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

async function fixture() {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('Group context rotation') RETURNING id",
  );
  const owner = await database().query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ('rotation-owner', 'Owner') RETURNING id",
  );
  await database().query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
    [family.rows[0]!.id, owner.rows[0]!.id],
  );
  const groups = await database().query<{ id: string; telegram_chat_id: string }>(
    `INSERT INTO telegram_groups
       (family_id, telegram_chat_id, title, type, message_mode)
     VALUES
       ($1, '-100-rotation', 'Rotation target', 'external', 'addressed_only'),
       ($1, '-100-other', 'Other group', 'external', 'addressed_only')
     RETURNING id, telegram_chat_id`,
    [family.rows[0]!.id],
  );
  return {
    familyId: family.rows[0]!.id,
    groupId: groups.rows.find((row) => row.telegram_chat_id === "-100-rotation")!.id,
    otherGroupId: groups.rows.find((row) => row.telegram_chat_id === "-100-other")!.id,
    ownerId: owner.rows[0]!.id,
  };
}

function canonicalInput(
  data: Awaited<ReturnType<typeof fixture>>,
  groupId: string,
  topicId: number | null,
  now = new Date("2026-08-04T08:00:00.000Z"),
) {
  const topic = topicId === null ? "main" : `topic:${topicId}`;
  return {
    baseContinuationToken: `osinara:group:${groupId}:${topic}`,
    familyId: data.familyId,
    groupId,
    kind: "canonical" as const,
    now,
    scope: "group" as const,
    telegramForumTopicId: topicId,
    userId: null,
  };
}

describeWithDatabase("Telegram group context rotation repository", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE telegram_hitl_approvals, conversation_session_routes, conversation_sessions, conversation_route_generations, telegram_groups, family_memberships, users, families CASCADE",
    );
  });
  afterAll(closeDatabase);

  it("rotates every canonical topic while preserving pending tasks and other groups", async () => {
    const data = await fixture();
    const main = await sessionRepository.prepareTurn(canonicalInput(data, data.groupId, null));
    const pendingTask = await sessionRepository.prepareTurn(canonicalInput(data, data.groupId, 77));
    await sessionRepository.parkSession({
      applicationSessionId: pendingTask.id,
      pendingRequestId: "request-77",
      requesterTelegramUserId: "rotation-owner",
      requesterUserId: data.ownerId,
    });
    const topic = await sessionRepository.prepareTurn(canonicalInput(data, data.groupId, 77));
    const other = await sessionRepository.prepareTurn(canonicalInput(data, data.otherGroupId, null));

    await expect(telegramGroupAdministrationRepository.requestGroupSessionRotation({
      familyId: data.familyId,
      requestedBy: data.ownerId,
      telegramChatId: "-100-rotation",
    })).resolves.toEqual({
      groupId: data.groupId,
      requestedCanonicalSessions: 2,
    });
    const states = await database().query<{
      id: string;
      rotation_requested: boolean;
    }>(
      `SELECT id, rotation_requested_at IS NOT NULL AND rotation_reason = 'user_requested' AS rotation_requested
         FROM conversation_sessions
        WHERE id = ANY($1::uuid[])
        ORDER BY id`,
      [[main.id, pendingTask.id, topic.id, other.id]],
    );
    const byId = new Map(states.rows.map((row) => [row.id, row.rotation_requested]));
    expect(byId.get(main.id)).toBe(true);
    expect(byId.get(topic.id)).toBe(true);
    expect(byId.get(pendingTask.id)).toBe(false);
    expect(byId.get(other.id)).toBe(false);

    const nextTurnAt = new Date("2026-08-04T08:01:00.000Z");
    const rotatedMain = await sessionRepository.prepareTurn(
      canonicalInput(data, data.groupId, null, nextTurnAt),
    );
    const rotatedTopic = await sessionRepository.prepareTurn(
      canonicalInput(data, data.groupId, 77, nextTurnAt),
    );
    expect(rotatedMain).toMatchObject({ generation: main.generation + 1, rotated: true });
    expect(rotatedMain.id).not.toBe(main.id);
    expect(rotatedTopic).toMatchObject({ generation: topic.generation + 1, rotated: true });
    expect(rotatedTopic.id).not.toBe(topic.id);
  });

  it("serializes owner rotation with a concurrent canonical preparation", async () => {
    const data = await fixture();
    const mainInput = canonicalInput(data, data.groupId, null);
    const main = await sessionRepository.prepareTurn(mainInput);
    const lockClient = await database().connect();
    await lockClient.query("BEGIN");
    await lockClient.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, $2))",
      [data.groupId, SESSION_GROUP_ROTATION_LOCK_HASH_SEED],
    );

    let preparationSettled = false;
    let rotationSettled = false;
    const preparation = sessionRepository.prepareTurn({
      ...mainInput,
      now: new Date("2026-08-04T08:00:30.000Z"),
    }).finally(() => {
      preparationSettled = true;
    });
    const rotation = telegramGroupAdministrationRepository.requestGroupSessionRotation({
      familyId: data.familyId,
      requestedBy: data.ownerId,
      telegramChatId: "-100-rotation",
    }).finally(() => {
      rotationSettled = true;
    });

    try {
      // Both operations must wait behind the same cross-process group boundary.
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(preparationSettled).toBe(false);
      expect(rotationSettled).toBe(false);
    } finally {
      await lockClient.query("ROLLBACK");
      lockClient.release();
    }

    const [concurrentTurn] = await Promise.all([preparation, rotation]);
    const followingTurn = await sessionRepository.prepareTurn({
      ...mainInput,
      now: new Date("2026-08-04T08:01:00.000Z"),
    });
    expect(concurrentTurn.rotated || followingTurn.rotated).toBe(true);
    expect(Math.max(concurrentTurn.generation, followingTurn.generation)).toBe(main.generation + 1);
  });

  it("treats a registered group without an active conversation as already fresh", async () => {
    const data = await fixture();

    await expect(telegramGroupAdministrationRepository.requestGroupSessionRotation({
      familyId: data.familyId,
      requestedBy: data.ownerId,
      telegramChatId: "-100-other",
    })).resolves.toEqual({
      groupId: data.otherGroupId,
      requestedCanonicalSessions: 0,
    });
  });

  it("rejects an unknown group without crossing the current family boundary", async () => {
    const data = await fixture();

    await expect(telegramGroupAdministrationRepository.requestGroupSessionRotation({
      familyId: data.familyId,
      requestedBy: data.ownerId,
      telegramChatId: "-100-missing",
    })).rejects.toThrowError(/AGENT_GROUP_NOT_FOUND/);
  });

  it("rejects a stale owner snapshot before changing any session", async () => {
    const data = await fixture();
    const main = await sessionRepository.prepareTurn(canonicalInput(data, data.groupId, null));
    await database().query(
      "DELETE FROM family_memberships WHERE family_id = $1 AND user_id = $2",
      [data.familyId, data.ownerId],
    );

    await expect(telegramGroupAdministrationRepository.requestGroupSessionRotation({
      familyId: data.familyId,
      requestedBy: data.ownerId,
      telegramChatId: "-100-rotation",
    })).rejects.toThrowError(/AGENT_OWNER_REQUIRED/);
    const session = await database().query<{ rotation_requested: boolean }>(
      `SELECT rotation_requested_at IS NOT NULL AS rotation_requested
         FROM conversation_sessions
        WHERE id = $1`,
      [main.id],
    );
    expect(session.rows[0]?.rotation_requested).toBe(false);
  });
});
