/**
 * Model-facing authored-skill tool tests.
 *
 * Constructs covered:
 * - Only the owner in a trusted chat reaches the repository; list and read need no approval.
 * - Publish, rollback and retire consume exact tool-call approval before the repository runs.
 * - Publish passes the mode catalog plus Eve built-ins as known tool names and the call id as the
 *   idempotency key; the result tells the model the skill is live from the next turn.
 * - Record_outcome resolves the owner's current conversation and needs no approval.
 */
import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const repository = vi.hoisted(() => ({
  conversationId: vi.fn(),
  list: vi.fn(),
  publish: vi.fn(),
  read: vi.fn(),
  recordOutcome: vi.fn(),
  retire: vi.fn(),
  rollback: vi.fn(),
}));
const grants = vi.hoisted(() => ({
  grant: vi.fn(),
  grants: vi.fn(),
  revoke: vi.fn(),
}));
const examples = vi.hoisted(() => ({
  add: vi.fn(),
  list: vi.fn(),
  remove: vi.fn(),
}));
const { requireApprovalEvidence, requireOwner } = vi.hoisted(() => ({
  requireApprovalEvidence: vi.fn(),
  requireOwner: vi.fn(),
}));

vi.mock("./authored-skills/authored-skill-repository.js", () => ({ authoredSkillRepository: repository }));
vi.mock("./authored-skills/authored-skill-grant-repository.js", () => ({ authoredSkillGrantRepository: grants }));
vi.mock("./authored-skills/authored-skill-example-repository.js", () => ({
  AUTHORED_SKILL_EXAMPLE_MAX_CHARACTERS: 1_000,
  AUTHORED_SKILL_EXAMPLES_MAX: 5,
  authoredSkillExampleRepository: examples,
}));
vi.mock("./family-context.js", () => ({ requireTrustedTelegramOwner: requireOwner }));
vi.mock("./require-tool-approval-evidence.js", () => ({
  requireToolApprovalEvidence: requireApprovalEvidence,
}));
vi.mock("./tool-policy/trusted-mode-tool-catalog.js", () => ({
  FAMILY_ONLY_TOOL_NAMES: ["list_group_history"],
  PRIVATE_ONLY_TOOL_NAMES: ["manage_telegram_group"],
  TRUSTED_MODE_TOOL_NAMES: ["generate_image", "send_workspace_file"],
}));

import manageSkill from "./tools/manage_skill.js";

const context = {
  callId: "skill-call-1",
  session: { id: "eve-session-1", turn: { id: "turn-7" } },
} as unknown as ToolContext;

const OWNER = {
  chatKind: "family" as const, familyId: "family-1", role: "owner" as const,
  telegramChatId: "-100", userId: "user-1",
};

describe("manage_skill", () => {
  beforeEach(() => {
    for (const mock of Object.values(repository)) mock.mockReset();
    for (const mock of Object.values(grants)) mock.mockReset();
    for (const mock of Object.values(examples)) mock.mockReset();
    grants.grants.mockResolvedValue([]);
    requireApprovalEvidence.mockReset();
    requireApprovalEvidence.mockResolvedValue(undefined);
    requireOwner.mockReset();
    requireOwner.mockReturnValue(OWNER);
  });

  it("lists and reads without approval evidence", async () => {
    repository.list.mockResolvedValue([]);
    repository.read.mockResolvedValue({ name: "birthday-card" });

    await expect(manageSkill.execute({ action: "list" }, context)).resolves.toEqual({ grants: [], skills: [] });
    await manageSkill.execute({ action: "read", name: "birthday-card", version: 2 }, context);

    expect(repository.read).toHaveBeenCalledWith("family-1", "birthday-card", 2);
    expect(requireApprovalEvidence).not.toHaveBeenCalled();
  });

  it("refuses everyone the trusted-owner guard refuses", async () => {
    requireOwner.mockImplementation(() => { throw new Error("AGENT_OWNER_REQUIRED"); });

    await expect(manageSkill.execute({ action: "list" }, context)).rejects.toThrow("AGENT_OWNER_REQUIRED");
    expect(repository.list).not.toHaveBeenCalled();
  });

  it("publishes only after exact approval with the mode catalog and the call id", async () => {
    repository.publish.mockResolvedValue({ name: "birthday-card", replayed: false, version: 1 });
    const input = {
      action: "publish" as const, changeNote: "Первая версия", description: "Открытка",
      files: { "references/a.md": "x" }, markdown: "## Шаги", name: "birthday-card",
      trialRequest: "Открытка Жене", trialSummary: "Сделала открытку",
      trials: [{ exampleId: "0d8a5b2e-6e2c-4a3a-9c8e-1f2a3b4c5d6e", summary: "Прошло" }],
    };

    const result = await manageSkill.execute(input, context);

    expect(requireApprovalEvidence).toHaveBeenCalledWith(context, "manage_skill", input);
    expect(requireApprovalEvidence.mock.invocationCallOrder[0])
      .toBeLessThan(repository.publish.mock.invocationCallOrder[0]!);
    const [caller, draft, options] = repository.publish.mock.calls[0]!;
    expect(caller).toEqual({ familyId: "family-1", role: "owner", userId: "user-1" });
    expect(draft).toEqual({
      changeNote: "Первая версия", description: "Открытка", files: { "references/a.md": "x" },
      markdown: "## Шаги", name: "birthday-card", trialSummary: "Сделала открытку",
    });
    expect(options.operationKey).toBe("skill-call-1");
    expect(options.provenance).toEqual({ eveSessionId: "eve-session-1", eveTurnId: "turn-7" });
    expect(options.trialRequest).toBe("Открытка Жене");
    expect(options.trials).toEqual([{ exampleId: "0d8a5b2e-6e2c-4a3a-9c8e-1f2a3b4c5d6e", summary: "Прошло" }]);
    expect([...options.knownToolNames]).toEqual(expect.arrayContaining([
      "generate_image", "send_workspace_file", "list_group_history", "web_search", "bash",
    ]));
    expect([...options.knownToolNames]).not.toContain("manage_telegram_group");
    expect(result).toMatchObject({ name: "birthday-card", note: expect.stringMatching(/следующего хода/u), version: 1 });
  });

  it("rejects publish without a trial summary or trial request before asking for approval", async () => {
    await expect(manageSkill.execute({
      action: "publish", changeNote: "x", description: "d", markdown: "m", name: "birthday-card",
    }, context)).rejects.toMatchObject({ code: "AGENT_SKILL_INPUT_INVALID" });
    await expect(manageSkill.execute({
      action: "publish", changeNote: "x", description: "d", markdown: "m", name: "birthday-card", trialSummary: "s",
    }, context)).rejects.toMatchObject({ code: "AGENT_SKILL_INPUT_INVALID" });
    expect(requireApprovalEvidence).not.toHaveBeenCalled();
  });

  it("adds and removes examples without approval", async () => {
    examples.add.mockResolvedValue({ createdAt: "2026-09-06T00:00:00.000Z", expected: "Тюльпаны", id: "e1", request: "Маме" });
    examples.remove.mockResolvedValue({ exampleId: "0d8a5b2e-6e2c-4a3a-9c8e-1f2a3b4c5d6e", name: "birthday-card" });

    await manageSkill.execute({ action: "add_example", expected: "Тюльпаны", name: "birthday-card", request: "Маме" }, context);
    await manageSkill.execute({ action: "remove_example", exampleId: "0d8a5b2e-6e2c-4a3a-9c8e-1f2a3b4c5d6e", name: "birthday-card" }, context);

    expect(examples.add).toHaveBeenCalledWith(
      { familyId: "family-1", role: "owner", userId: "user-1" }, { expected: "Тюльпаны", name: "birthday-card", request: "Маме" },
    );
    expect(examples.remove).toHaveBeenCalledWith(
      { familyId: "family-1", role: "owner", userId: "user-1" }, { exampleId: "0d8a5b2e-6e2c-4a3a-9c8e-1f2a3b4c5d6e", name: "birthday-card" },
    );
    await expect(manageSkill.execute({ action: "add_example", name: "birthday-card", request: "Маме" }, context))
      .rejects.toMatchObject({ code: "AGENT_SKILL_INPUT_INVALID" });
    expect(requireApprovalEvidence).not.toHaveBeenCalled();
  });

  it("rolls back and retires through approval", async () => {
    repository.rollback.mockResolvedValue({ name: "birthday-card", replayed: false, version: 3 });
    repository.retire.mockResolvedValue({ name: "birthday-card", version: 3 });

    await manageSkill.execute({ action: "rollback", name: "birthday-card", version: 1 }, context);
    await manageSkill.execute({ action: "retire", name: "birthday-card" }, context);

    expect(requireApprovalEvidence).toHaveBeenCalledTimes(2);
    expect(repository.rollback).toHaveBeenCalledWith(
      { familyId: "family-1", role: "owner", userId: "user-1" },
      { knownToolNames: expect.any(Set), name: "birthday-card", operationKey: "skill-call-1", provenance: { eveSessionId: "eve-session-1", eveTurnId: "turn-7" }, version: 1 },
    );
    expect(repository.retire).toHaveBeenCalledWith(
      { familyId: "family-1", role: "owner", userId: "user-1" }, { name: "birthday-card" },
    );
  });

  it("records an outcome for the owner's current conversation without approval", async () => {
    repository.conversationId.mockResolvedValue("conversation-9");
    repository.recordOutcome.mockResolvedValue({ name: "birthday-card", outcome: "failed", usageFound: true });

    await manageSkill.execute({ action: "record_outcome", name: "birthday-card", note: "текст на картинке", outcome: "failed" }, context);

    expect(repository.conversationId).toHaveBeenCalledWith(OWNER);
    expect(repository.recordOutcome).toHaveBeenCalledWith(
      { familyId: "family-1", role: "owner", userId: "user-1" },
      { conversationId: "conversation-9", name: "birthday-card", note: "текст на картинке", outcome: "failed", source: "owner" },
    );
    expect(requireApprovalEvidence).not.toHaveBeenCalled();
  });

  it("grants and revokes for an external group through approval", async () => {
    grants.grant.mockResolvedValue({ granted: true, group: { telegramChatId: "-100", title: "Клуб" }, name: "weekly-digest" });
    grants.revoke.mockResolvedValue({ group: { telegramChatId: "-100", title: "Клуб" }, name: "weekly-digest" });

    const granted = await manageSkill.execute({ action: "grant", group: "Клуб", name: "weekly-digest" }, context);
    await manageSkill.execute({ action: "revoke", group: "-100", name: "weekly-digest" }, context);

    expect(requireApprovalEvidence).toHaveBeenCalledTimes(2);
    expect(grants.grant).toHaveBeenCalledWith(
      { familyId: "family-1", role: "owner", userId: "user-1" }, { group: "Клуб", name: "weekly-digest" },
    );
    expect(grants.revoke).toHaveBeenCalledWith(
      { familyId: "family-1", role: "owner", userId: "user-1" }, { group: "-100", name: "weekly-digest" },
    );
    expect(granted).toMatchObject({ granted: true, note: expect.stringMatching(/следующего хода/u) });
    await expect(manageSkill.execute({ action: "grant", name: "weekly-digest" }, context))
      .rejects.toMatchObject({ code: "AGENT_SKILL_INPUT_INVALID" });
  });

  it("marks only mutating actions as approval-bound", () => {
    const approval = manageSkill.approval as (input: { toolInput: unknown }) => string;
    expect(approval({ toolInput: { action: "publish" } })).toBe("user-approval");
    expect(approval({ toolInput: { action: "retire" } })).toBe("user-approval");
    expect(approval({ toolInput: { action: "grant" } })).toBe("user-approval");
    expect(approval({ toolInput: { action: "revoke" } })).toBe("user-approval");
    expect(approval({ toolInput: { action: "list" } })).toBe("not-applicable");
    expect(approval({ toolInput: { action: "record_outcome" } })).toBe("not-applicable");
    expect(approval({ toolInput: { action: "add_example" } })).toBe("not-applicable");
    expect(approval({ toolInput: { action: "remove_example" } })).toBe("not-applicable");
  });
});
