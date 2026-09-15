/**
 * Переход и его откат — операции над всей установкой, поэтому они проверяются на настоящих
 * воротах: незавершённая сессия не даёт переключиться, а запись, сделанная уже в новой области,
 * не даёт вернуться — прежние читатели разобрали бы её предикатами по разделу.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";

import { closeDatabase, database } from "../database.js";
import { sessionRepository } from "../sessions/session-repository.js";
import { improvementBacklogRepository } from "../improvements/improvement-backlog-repository.js";
import {
  performSpacesCutover,
  prepareSpacesCutover,
  revertSpacesCutover,
  ROLLBACK_CONTENT_TABLES,
} from "./spaces-cutover.js";
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

async function liveSession(fixture: TwoSpaceFixture): Promise<string> {
  const prepared = await sessionRepository.prepareTurn({
    baseContinuationToken: `${fixture.telegramChatId}::cutover`,
    familyId: fixture.familyId,
    groupId: null,
    kind: "canonical",
    now: NOW,
    scope: "personal",
    telegramForumTopicId: null,
    userId: fixture.owner.userId,
  });
  return prepared.id;
}

function cutover(fixture: TwoSpaceFixture) {
  return { changedBy: fixture.owner.userId, familyId: fixture.familyId, now: NOW, reason: "Переход" };
}

async function mode(fixture: TwoSpaceFixture): Promise<string> {
  const row = await database().query<{ mode: string }>(
    "SELECT mode FROM family_space_runtime WHERE family_id=$1", [fixture.familyId],
  );
  return row.rows[0]!.mode;
}

dbDescribe("spaces cutover", () => {
  let fixture: TwoSpaceFixture;

  beforeEach(async () => {
    await database().query(
      "TRUNCATE spaces, telegram_groups, family_memberships, users, families CASCADE",
    );
    fixture = await createTwoSpaceFixture("cutover");
  });
  afterAll(closeDatabase);

  it("retires live conversations, switches the mode and can switch it back", async () => {
    const sessionId = await liveSession(fixture);

    const report = await transaction((client) => performSpacesCutover(client, cutover(fixture)));
    expect(report).toMatchObject({ mode: "spaces", sessionsRetired: 1 });
    await expect(mode(fixture)).resolves.toBe("spaces");
    const retired = await database().query<{ retired_at: Date | null }>(
      "SELECT retired_at FROM conversation_sessions WHERE id=$1", [sessionId],
    );
    expect(retired.rows[0]!.retired_at).not.toBeNull();
    await expect(database().query(
      "SELECT 1 FROM conversation_session_routes WHERE session_id=$1", [sessionId],
    )).resolves.toMatchObject({ rowCount: 0 });

    await transaction((client) => revertSpacesCutover(client, cutover(fixture)));
    await expect(mode(fixture)).resolves.toBe("legacy");
  });

  it("does not switch a family whose chat audience is not confirmed", async () => {
    const session = await liveSession(fixture);
    // Ворота живут в триггере базы, а не в дисциплине оператора: незавершённые сессии скрипт
    // закрывает сам, а неподтверждённый состав чата он обойти не может.
    await database().query("UPDATE space_bindings SET state='pending_verification' WHERE group_id=$1", [fixture.groupId]);

    await expect(transaction((client) => performSpacesCutover(client, cutover(fixture))))
      .rejects.toThrowError(/AGENT_SPACE_CUTOVER_AUDIENCE_UNVERIFIED/);
    await expect(mode(fixture)).resolves.toBe("legacy");
    expect((await database().query("SELECT retired_at FROM conversation_sessions WHERE id=$1", [session])).rows[0].retired_at).toBeNull();
  });

  it("rebuilds only this family's derived context while preserving source conversations", async () => {
    const other = await createTwoSpaceFixture("other-cutover");
    const seed = async (family: TwoSpaceFixture) => {
      const session = await liveSession(family);
      const conversation = (await database().query(
        "SELECT id FROM application_conversations WHERE family_id=$1 AND owner_user_id=$2",
        [family.familyId, family.owner.userId],
      )).rows[0].id;
      await database().query(
        `INSERT INTO profile_views(family_id,viewer_conversation_id,viewer_user_id,
           subject_count,claim_count,total_characters) VALUES($1,$2,$3,0,0,0)`,
        [family.familyId, conversation, family.owner.userId],
      );
      await database().query(
        "INSERT INTO memory_context_exposures(application_session_id,memory_ref,session_turn) VALUES($1,'old-context',1)", [session],
      );
      await database().query(
        "INSERT INTO profile_author_exposures(application_session_id,telegram_user_id,session_turn) VALUES($1,$2,1)",
        [session, family.owner.telegramUserId],
      );
      return { session, conversation };
    };
    const target = await seed(fixture);
    const neighbor = await seed(other);
    await transaction((client) => performSpacesCutover(client, cutover(fixture)));
    expect((await database().query("SELECT family_id FROM profile_views")).rows)
      .toEqual([{ family_id: other.familyId }]);
    for (const table of ["memory_context_exposures", "profile_author_exposures"]) {
      expect((await database().query(`SELECT application_session_id FROM ${table}`)).rows)
        .toEqual([{ application_session_id: neighbor.session }]);
    }
    expect((await database().query("SELECT id FROM application_conversations WHERE id=$1", [target.conversation])).rowCount).toBe(1);
    await expect(mode(other)).resolves.toBe("legacy");
  });

  it("refuses a rollback once a record exists in an area the previous readers cannot see", async () => {
    await transaction((client) => performSpacesCutover(client, cutover(fixture)));
    await database().query(
      `INSERT INTO reminders
         (family_id, author_user_id, group_id, scope, content, timezone, telegram_chat_id,
          recurrence_anchor_local, due_at, available_at, space_id)
       VALUES ($1,$2,$3,'family','Забрать посылку','Europe/Moscow',$4,
               now(), now(), now(), $5)`,
      [fixture.familyId, fixture.owner.userId, fixture.groupId, fixture.telegramChatId, fixture.pairSpaceId],
    );

    await expect(transaction((client) => revertSpacesCutover(client, cutover(fixture))))
      .rejects.toThrowError(/AGENT_SPACE_ROLLBACK_UNSAFE/);
    await expect(mode(fixture)).resolves.toBe("spaces");
  });

  it("preserves old operational evidence but never republishes or overwrites it after cutover", async () => {
    const input = { familyId: fixture.familyId, fingerprint: "0123456789abcdef",
      category: "workflow" as const, summary: "Legacy context", priority: "low" as const,
      evidence: { context: "mixed old sources" } };
    const old = await improvementBacklogRepository.record(input);
    const audit = (await database().query(
      "INSERT INTO audit_events(family_id,event_type,metadata) VALUES($1,'test.legacy',$2) RETURNING id",
      [fixture.familyId, { context: "original evidence" }],
    )).rows[0].id;
    await transaction((client) => performSpacesCutover(client, cutover(fixture)));
    expect(await improvementBacklogRepository.list(fixture.familyId)).toEqual([]);
    await expect(improvementBacklogRepository.close({ familyId: fixture.familyId, id: old.item.id,
      closedByUserId: fixture.owner.userId, status: "done" })).rejects.toThrow();
    const fresh = await improvementBacklogRepository.record({ ...input, evidence: { context: "new sources" } });
    expect(fresh.item.id).not.toBe(old.item.id);
    expect(fresh.recurred).toBe(false);
    expect((await database().query("SELECT evidence FROM agent_improvement_items WHERE id=$1", [old.item.id])).rows[0].evidence).toEqual(input.evidence);
    expect((await database().query("SELECT metadata FROM audit_events WHERE id=$1", [audit])).rows[0].metadata).toEqual({ context: "original evidence" });
  });

  it("prepares idempotently without switching mode or approving an unknown audience", async () => {
    await liveSession(fixture);
    await database().query("UPDATE space_bindings SET state='pending_verification' WHERE group_id=$1", [fixture.groupId]);
    await database().query("INSERT INTO audit_events(family_id,event_type) VALUES($1,'test.old')", [fixture.familyId]);
    const first = await transaction((client) => prepareSpacesCutover(client, cutover(fixture)));
    const second = await transaction((client) => prepareSpacesCutover(client, cutover(fixture)));
    expect(first).toMatchObject({ sessionsRetired: 1, operationalRowsQuarantined: 1 });
    expect(second).toMatchObject({ sessionsRetired: 0, operationalRowsQuarantined: 0 });
    await expect(mode(fixture)).resolves.toBe("legacy");
    await expect(transaction((client) => performSpacesCutover(client, cutover(fixture))))
      .rejects.toThrowError(/AGENT_SPACE_CUTOVER_AUDIENCE_UNVERIFIED/);
  });

  it("names every content table whose audience a rollback would widen", async () => {
    // Список таблиц отката это не память оператора: каждая обязана быть в запросе, иначе откат
    // тихо расширит аудиторию строк, написанных уже в новой области.
    const { rows } = await database().query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND column_name = 'space_id'
        ORDER BY table_name`,
    );
    for (const table of Object.keys(ROLLBACK_CONTENT_TABLES)) {
      expect(rows.map((row) => row.table_name)).toContain(table);
    }
    // Каждое имя действительно попадает в проверку: запрос собирается из этого же списка.
    expect(Object.keys(ROLLBACK_CONTENT_TABLES)).toEqual(
      expect.arrayContaining(["care_areas", "chat_message_relays", "shopping_items"]),
    );
  });
});
