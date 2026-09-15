/**
 * Repeat-task hint repository integration tests.
 *
 * Constructs covered:
 * - Save upserts one row per conversation; take returns it once and deletes it.
 * - A hint older than the TTL is deleted without being returned.
 * - A backlog hint replaces a repeat hint and comes back with its summary.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { createMainAgentMemoryFixture } from "../memory-agent-write.integration-fixtures.js";
import { skillHintRepository } from "./skill-hint-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

describeWithDatabase("skill hint repository", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE users, families CASCADE");
  });

  afterAll(closeDatabase);

  it("keeps one hint per conversation and hands it out once", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const base = { conversationId: fixture.conversationId, eveSessionId: "s", familyId: fixture.familyId };

    await skillHintRepository.save({ ...base, eveTurnId: "t1", kind: "repeat", stepCount: 4, toolNames: ["web_search"] });
    await skillHintRepository.save({ ...base, eveTurnId: "t2", kind: "repeat", stepCount: 6, toolNames: ["web_search", "bash"] });

    await expect(skillHintRepository.take(fixture.conversationId))
      .resolves.toEqual({ kind: "repeat", stepCount: 6, toolNames: ["web_search", "bash"] });
    await expect(skillHintRepository.take(fixture.conversationId)).resolves.toBeNull();
  });

  it("replaces a repeat hint with a backlog hint and returns the summary", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const base = { conversationId: fixture.conversationId, eveSessionId: "s", familyId: fixture.familyId };

    await skillHintRepository.save({ ...base, eveTurnId: "t1", kind: "repeat", stepCount: 4, toolNames: ["web_search"] });
    await skillHintRepository.save({ ...base, eveTurnId: "t2", kind: "backlog", summary: "Поиск расписания занимает шесть шагов" });

    await expect(skillHintRepository.take(fixture.conversationId))
      .resolves.toEqual({ kind: "backlog", summary: "Поиск расписания занимает шесть шагов" });
  });

  it("drops a stale hint instead of showing it", async () => {
    const fixture = await createMainAgentMemoryFixture();
    await skillHintRepository.save({
      conversationId: fixture.conversationId, eveSessionId: "s", eveTurnId: "t1",
      familyId: fixture.familyId, kind: "repeat", stepCount: 4, toolNames: ["web_search"],
    });

    const later = new Date(Date.now() + 25 * 60 * 60 * 1_000);
    await expect(skillHintRepository.take(fixture.conversationId, later)).resolves.toBeNull();
    await expect(database().query("SELECT 1 FROM conversation_skill_hints")).resolves.toMatchObject({ rowCount: 0 });
  });
});
