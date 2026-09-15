/**
 * Восстановление дампа возвращает и очередь Telegram, и просроченные сигналы, и живые сессии.
 * Без подавления они срабатывают лавиной при первом запуске: человек получает поток старых
 * уведомлений и ответы на вопросы, заданные до отката, а отправленное уже не отзывается.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";

import { closeDatabase, database } from "../database.js";
import { sessionRepository } from "../sessions/session-repository.js";
import { suppressAfterRestore, verifyClosedRollback } from "./closed-rollback.js";
import { createTwoSpaceFixture, type TwoSpaceFixture } from "./two-space-fixture.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const dbDescribe = enabled ? describe : describe.skip;
const NOW = new Date("2026-09-11T12:00:00.000Z");

async function transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

dbDescribe("closed rollback", () => {
  let fixture: TwoSpaceFixture;

  beforeEach(async () => {
    await database().query(
      `TRUNCATE telegram_ingress_updates, telegram_ingress_queues, reminders, agent_schedules,
       conversation_sessions, spaces, telegram_groups, family_memberships, users, families CASCADE`,
    );
    fixture = await createTwoSpaceFixture("rollback");
    await sessionRepository.prepareTurn({
      baseContinuationToken: `${fixture.telegramChatId}::rollback`,
      familyId: fixture.familyId,
      groupId: null,
      kind: "canonical",
      now: NOW,
      scope: "personal",
      telegramForumTopicId: null,
      userId: fixture.owner.userId,
    });
    await database().query(
      `INSERT INTO reminders
         (family_id, author_user_id, owner_user_id, scope, content, timezone, telegram_chat_id,
          recurrence_anchor_local, due_at, available_at)
       VALUES ($1,$2,$2,'personal','Забрать посылку','Europe/Moscow',$3,
               now(), $4, $4)`,
      [fixture.familyId, fixture.owner.userId, fixture.owner.telegramUserId,
        new Date(NOW.getTime() - 3_600_000)],
    );
    const queue = await database().query<{ id: string }>(
      `INSERT INTO telegram_ingress_queues (current_continuation_key) VALUES ('-1001::')
       RETURNING id`,
    );
    await database().query(
      `INSERT INTO telegram_ingress_updates
         (update_id, queue_id, ingress_continuation_key, payload)
       VALUES (1, $1, '-1001::', '{"update_id":1}'::jsonb)`,
      [queue.rows[0]!.id],
    );
  });
  afterAll(closeDatabase);

  it("names every signal that would fire by itself and falls silent after suppression", async () => {
    const before = await transaction((client) => verifyClosedRollback(client, NOW));
    expect(before).toMatchObject({ dueReminders: 1, liveSessions: 1, queuedUpdates: 1 });
    expect(before.blockers).toEqual(expect.arrayContaining([
      "AGENT_ROLLBACK_INGRESS_QUEUE_NOT_EMPTY",
      "AGENT_ROLLBACK_REMINDERS_DUE",
      "AGENT_ROLLBACK_SESSIONS_LIVE",
    ]));

    const after = await transaction((client) => suppressAfterRestore(client, NOW));
    expect(after.blockers).toEqual([]);
    // Напоминание приостановлено, а не завершено: его ещё может понадобиться перенести.
    const reminder = await database().query<{ status: string }>(
      "SELECT status FROM reminders WHERE family_id=$1", [fixture.familyId],
    );
    expect(reminder.rows[0]!.status).toBe("paused");
  });
});
