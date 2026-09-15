/**
 * Authored skill repository integration tests.
 *
 * Constructs covered:
 * - Publish creates version 1, republish bumps the version, the same operation key replays.
 * - Rollback copies an old version into a new one; retire hides the skill from resolver packages.
 * - Only a current owner may mutate; a member of the family is refused.
 * - The active-skill limit is enforced per family.
 * - Usage rows come from observed loads and take the latest outcome per conversation.
 * - The publish trial becomes an example; version 2+ needs a rerun of every active example.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import type { FamilyCaller } from "../family-context.js";
import { createMainAgentMemoryFixture } from "../memory-agent-write.integration-fixtures.js";
import { AUTHORED_SKILL_LIMITS } from "./authored-skill-contract.js";
import { AUTHORED_SKILL_EXAMPLES_MAX, authoredSkillExampleRepository } from "./authored-skill-example-repository.js";
import { authoredSkillRepository } from "./authored-skill-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

const KNOWN = new Set(["generate_image", "send_workspace_file"]);
const MARKDOWN = [
  "## Когда применять", "Когда просят открытку.",
  "## Шаги", "1. Вызови `generate_image`.", "2. Отправь `send_workspace_file`.",
  "## Проверка результата", "Картинка без текста.",
].join("\n");

function draft(name: string, changeNote = "Первая версия") {
  return {
    changeNote,
    description: "Открытка к празднику через Flux",
    // An image skill must carry its prompt template; the rubric refuses it otherwise.
    files: { "references/card.md": "Warm greeting card, one central motif, no text, 512x512." },
    markdown: MARKDOWN,
    name,
    trialSummary: "Сгенерировала одну открытку, отправила в чат.",
  };
}

const provenance = { eveSessionId: "eve-skill-session", eveTurnId: "turn-skill" };

describeWithDatabase("authored skill repository", () => {
  let owner: FamilyCaller;
  let familyId: string;
  let conversationId: string;

  beforeEach(async () => {
    await database().query("TRUNCATE users, families CASCADE");
    const fixture = await createMainAgentMemoryFixture();
    owner = { familyId: fixture.familyId, role: "owner", userId: fixture.userId };
    familyId = fixture.familyId;
    conversationId = fixture.conversationId;
  });

  afterAll(closeDatabase);

  it("publishes, republishes as a new version and replays the same operation key", async () => {
    const first = await authoredSkillRepository.publish(owner, draft("birthday-card"), {
      knownToolNames: KNOWN, operationKey: "call-1", provenance,
    });
    expect(first).toMatchObject({ name: "birthday-card", replayed: false, version: 1 });

    const replay = await authoredSkillRepository.publish(owner, draft("birthday-card"), {
      knownToolNames: KNOWN, operationKey: "call-1", provenance,
    });
    expect(replay).toMatchObject({ name: "birthday-card", replayed: true, version: 1 });

    const second = await authoredSkillRepository.publish(owner, draft("birthday-card", "Короче шаги"), {
      knownToolNames: KNOWN, operationKey: "call-2", provenance,
    });
    expect(second).toMatchObject({ name: "birthday-card", replayed: false, version: 2 });

    const listed = await authoredSkillRepository.list(familyId);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ name: "birthday-card", usageCount: 0, version: 2 });
    const read = await authoredSkillRepository.read(familyId, "birthday-card", 1);
    expect(read).toMatchObject({ changeNote: "Первая версия", version: 1 });
  });

  it("stores the trial as an example and demands a rerun of every example before a new version", async () => {
    const first = await authoredSkillRepository.publish(owner, draft("birthday-card"), {
      knownToolNames: KNOWN, operationKey: "call-1", provenance, trialRequest: "Открытка Жене",
    });
    expect(first.exampleAdded).toMatchObject({ expected: "Сгенерировала одну открытку, отправила в чат.", request: "Открытка Жене" });
    const second = await authoredSkillExampleRepository.add(owner, {
      expected: "Тюльпаны без текста", name: "birthday-card", request: "Открытка маме на 8 марта",
    });
    await expect(authoredSkillExampleRepository.add({ ...owner, role: "member" }, {
      expected: "x", name: "birthday-card", request: "y",
    })).rejects.toMatchObject({ code: "AGENT_SKILL_FORBIDDEN" });

    // Version 2 without reruns, with a partial rerun, and with an unknown example id are refused.
    await expect(authoredSkillRepository.publish(owner, draft("birthday-card", "Короче шаги"), {
      knownToolNames: KNOWN, operationKey: "call-2", provenance,
    })).rejects.toMatchObject({ code: "AGENT_SKILL_EVAL_MISSING", message: expect.stringContaining("Открытка маме") });
    await expect(authoredSkillRepository.publish(owner, draft("birthday-card", "Короче шаги"), {
      knownToolNames: KNOWN, operationKey: "call-2", provenance,
      trials: [{ exampleId: first.exampleAdded!.id, summary: "Прошло" }],
    })).rejects.toMatchObject({ code: "AGENT_SKILL_EVAL_MISSING" });
    await expect(authoredSkillRepository.publish(owner, draft("birthday-card", "Короче шаги"), {
      knownToolNames: KNOWN, operationKey: "call-2", provenance,
      trials: [{ exampleId: "00000000-0000-4000-8000-000000000099", summary: "Прошло" }],
    })).rejects.toMatchObject({ code: "AGENT_SKILL_EVAL_UNKNOWN_EXAMPLE" });

    const trials = [
      { exampleId: first.exampleAdded!.id, summary: "Открытка без текста" },
      { exampleId: second.id, summary: "Тюльпаны, без текста" },
    ];
    const published = await authoredSkillRepository.publish(owner, draft("birthday-card", "Короче шаги"), {
      knownToolNames: KNOWN, operationKey: "call-2", provenance, trials,
    });
    expect(published).toMatchObject({ exampleAdded: null, version: 2 });
    const read = await authoredSkillRepository.read(familyId, "birthday-card");
    expect(read.trials).toEqual(trials);
    expect(read.examples.map((example) => example.request)).toEqual(["Открытка Жене", "Открытка маме на 8 марта"]);

    // A removed example is no longer demanded; the cap holds at five active examples.
    await authoredSkillExampleRepository.remove(owner, { exampleId: second.id, name: "birthday-card" });
    await expect(authoredSkillExampleRepository.remove(owner, { exampleId: second.id, name: "birthday-card" }))
      .rejects.toMatchObject({ code: "AGENT_SKILL_EXAMPLE_NOT_FOUND" });
    for (let index = 0; index < AUTHORED_SKILL_EXAMPLES_MAX - 1; index += 1) {
      await authoredSkillExampleRepository.add(owner, { expected: "ок", name: "birthday-card", request: `Пример ${index}` });
    }
    await expect(authoredSkillExampleRepository.add(owner, { expected: "ок", name: "birthday-card", request: "лишний" }))
      .rejects.toMatchObject({ code: "AGENT_SKILL_EXAMPLE_LIMIT_REACHED" });
    await expect(authoredSkillExampleRepository.list(familyId, "birthday-card")).resolves.toHaveLength(AUTHORED_SKILL_EXAMPLES_MAX);
  });

  it("rolls back by creating a new version with the old content and retires from packages", async () => {
    await authoredSkillRepository.publish(owner, draft("birthday-card"), {
      knownToolNames: KNOWN, operationKey: "call-1", provenance,
    });
    await authoredSkillRepository.publish(owner, {
      ...draft("birthday-card", "Другое описание"), description: "Версия два",
    }, { knownToolNames: KNOWN, operationKey: "call-2", provenance });

    const rolled = await authoredSkillRepository.rollback(owner, {
      knownToolNames: KNOWN, name: "birthday-card", operationKey: "call-3", provenance, version: 1,
    });
    expect(rolled).toMatchObject({ name: "birthday-card", replayed: false, version: 3 });
    // A version whose steps name a tool the current mode no longer has cannot come back.
    await expect(authoredSkillRepository.rollback(owner, {
      knownToolNames: new Set(), name: "birthday-card", operationKey: "call-3b", provenance, version: 1,
    })).rejects.toMatchObject({ code: "AGENT_SKILL_RUBRIC_FAILED" });
    const packages = await authoredSkillRepository.activePackages(familyId);
    expect(packages).toEqual([expect.objectContaining({
      description: "Открытка к празднику через Flux", name: "birthday-card",
    })]);

    await authoredSkillRepository.retire(owner, { name: "birthday-card" });
    await expect(authoredSkillRepository.activePackages(familyId)).resolves.toEqual([]);
    await expect(authoredSkillRepository.read(familyId, "birthday-card"))
      .rejects.toMatchObject({ code: "AGENT_SKILL_NOT_FOUND" });
    await expect(authoredSkillRepository.rollback(owner, {
      knownToolNames: KNOWN, name: "birthday-card", operationKey: "call-4", provenance, version: 1,
    })).rejects.toMatchObject({ code: "AGENT_SKILL_NOT_FOUND" });
  });

  it("refuses a family member and a stale owner", async () => {
    const member: FamilyCaller = { ...owner, role: "member" };
    await expect(authoredSkillRepository.publish(member, draft("birthday-card"), {
      knownToolNames: KNOWN, operationKey: "call-1", provenance,
    })).rejects.toMatchObject({ code: "AGENT_SKILL_FORBIDDEN" });

    await database().query(
      "UPDATE family_memberships SET role = 'member' WHERE family_id = $1 AND user_id = $2",
      [familyId, owner.userId],
    );
    await expect(authoredSkillRepository.publish(owner, draft("birthday-card"), {
      knownToolNames: KNOWN, operationKey: "call-2", provenance,
    })).rejects.toMatchObject({ code: "AGENT_SKILL_FORBIDDEN" });
  });

  it("enforces the active-skill limit per family", async () => {
    for (let index = 0; index < AUTHORED_SKILL_LIMITS.activeSkillsPerFamily; index += 1) {
      await database().query(
        `INSERT INTO authored_skills (family_id, name, description, markdown, version, status)
         VALUES ($1, $2, 'd', 'm', 1, 'active')`,
        [familyId, `skill-${index}`],
      );
    }
    await expect(authoredSkillRepository.publish(owner, draft("one-more"), {
      knownToolNames: KNOWN, operationKey: "call-1", provenance,
    })).rejects.toMatchObject({ code: "AGENT_SKILL_LIMIT_REACHED" });
  });

  it("records observed loads and the latest outcome per conversation", async () => {
    await authoredSkillRepository.publish(owner, draft("birthday-card"), {
      knownToolNames: KNOWN, operationKey: "call-1", provenance,
    });
    await expect(authoredSkillRepository.recordUsage({
      conversationId, eveSessionId: "s1", eveTurnId: "t1", familyId, skillName: "unknown-skill",
    })).resolves.toBe(false);
    await expect(authoredSkillRepository.recordUsage({
      conversationId, eveSessionId: "s1", eveTurnId: "t1", familyId, skillName: "birthday-card",
    })).resolves.toBe(true);
    await expect(authoredSkillRepository.recordUsage({
      conversationId: null, eveSessionId: "s2", eveTurnId: "t2", familyId, skillName: "birthday-card",
    })).resolves.toBe(true);

    await expect(authoredSkillRepository.recordOutcome(owner, {
      conversationId, name: "birthday-card", note: "картинка с текстом", outcome: "failed", source: "owner",
    })).resolves.toEqual({ name: "birthday-card", outcome: "failed", usageFound: true });

    const outcomes = await database().query<{ conversation_id: string | null; outcome: string }>(
      `SELECT usage.conversation_id, usage.outcome FROM authored_skill_usage AS usage
        ORDER BY usage.loaded_at`,
    );
    expect(outcomes.rows).toEqual([
      { conversation_id: conversationId, outcome: "failed" },
      { conversation_id: null, outcome: "unknown" },
    ]);
    const listed = await authoredSkillRepository.list(familyId);
    expect(listed[0]).toMatchObject({ lastOutcome: "unknown", usageCount: 2 });

    // Upstream 960c4b9: an unknown conversation must not pick the family's latest usage anywhere.
    await expect(authoredSkillRepository.recordOutcome(owner, {
      conversationId: null, name: "birthday-card", note: null, outcome: "ok", source: "owner",
    })).rejects.toMatchObject({ code: "AGENT_SKILL_OUTCOME_CONVERSATION_REQUIRED" });

    // An automatic failure never overwrites the outcome the owner gave for the same usage.
    await expect(authoredSkillRepository.recordOutcome(owner, {
      conversationId, name: "birthday-card", note: "вышло", outcome: "ok", source: "owner",
    })).resolves.toMatchObject({ outcome: "ok", usageFound: true });
    await expect(authoredSkillRepository.recordOutcome(owner, {
      conversationId, name: "birthday-card", note: "9 шагов инструментов", outcome: "failed", source: "automatic",
    })).resolves.toMatchObject({ usageFound: false });
    const kept = await database().query<{ conversation_id: string | null; note: string | null; outcome: string }>(
      "SELECT conversation_id, outcome, note FROM authored_skill_usage ORDER BY loaded_at",
    );
    expect(kept.rows).toEqual([
      { conversation_id: conversationId, note: "вышло", outcome: "ok" },
      { conversation_id: null, note: null, outcome: "unknown" },
    ]);

    await expect(authoredSkillRepository.isAuthoredSkill(familyId, "birthday-card")).resolves.toBe(true);
    await expect(authoredSkillRepository.isAuthoredSkill(familyId, "imagegen")).resolves.toBe(false);
  });
});
