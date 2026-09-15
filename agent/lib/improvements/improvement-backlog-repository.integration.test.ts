/**
 * Improvement backlog repository integration tests.
 *
 * Constructs covered:
 * - A repeated fingerprint bumps recurrence and keeps the highest priority instead of inserting.
 * - Listing ranks by priority, then recurrence, then recency.
 * - Closing an item removes it from the open list and a later recurrence opens a fresh row.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { improvementBacklogRepository } from "./improvement-backlog-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

describeWithDatabase("improvementBacklogRepository", () => {
  let familyId: string;

  beforeEach(async () => {
    await database().query("TRUNCATE agent_improvement_items, users, families CASCADE");
    const family = await database().query<{ id: string }>("INSERT INTO families (name) VALUES ('Бэклог') RETURNING id");
    familyId = family.rows[0]!.id;
  });

  afterAll(closeDatabase);

  it("records, recurs, ranks, and closes items", async () => {
    const first = await improvementBacklogRepository.record({
      category: "tool_error", evidence: { toolName: "generate_image" }, familyId,
      fingerprint: "0123456789abcdef", priority: "low", summary: "Провайдер картинок падает",
    });
    expect(first.recurred).toBe(false);
    const again = await improvementBacklogRepository.record({
      category: "tool_error", evidence: { toolName: "generate_image", second: true }, familyId,
      fingerprint: "0123456789abcdef", priority: "high", summary: "Провайдер картинок падает снова",
    });
    expect(again.recurred).toBe(true);
    expect(again.item).toMatchObject({ id: first.item.id, priority: "high", recurrenceCount: 2, summary: "Провайдер картинок падает" });

    await improvementBacklogRepository.record({
      category: "workflow", evidence: {}, familyId, fingerprint: "fedcba9876543210", priority: "high", summary: "Слишком много шагов",
    });
    const open = await improvementBacklogRepository.list(familyId);
    expect(open.map((item) => item.summary)).toEqual(["Провайдер картинок падает", "Слишком много шагов"]);

    const closed = await improvementBacklogRepository.close({ closedByUserId: null, familyId, id: first.item.id, status: "done" });
    expect(closed.status).toBe("done");
    expect((await improvementBacklogRepository.list(familyId)).map((item) => item.summary)).toEqual(["Слишком много шагов"]);
    await expect(improvementBacklogRepository.close({ closedByUserId: null, familyId, id: first.item.id, status: "done" }))
      .rejects.toMatchObject({ code: "AGENT_IMPROVEMENT_NOT_FOUND" });

    const reopened = await improvementBacklogRepository.record({
      category: "tool_error", evidence: {}, familyId, fingerprint: "0123456789abcdef", priority: "low", summary: "Провайдер картинок падает",
    });
    expect(reopened.recurred).toBe(false);
    expect(reopened.item.id).not.toBe(first.item.id);
  });
});
