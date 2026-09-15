/**
 * Reflection and signal handler tests.
 *
 * Constructs covered:
 * - Parsing keeps only valid categories and priorities and drops tools or codes the evidence
 *   never named; malformed output is an empty list.
 * - The rate limiter admits N per family per hour.
 * - Handlers reflect on a failed tool in an external group, skip a quiet turn, skip review
 *   sessions, and record items with the fingerprint.
 * - A loaded authored skill in a failed turn gets an automatic failed outcome and a `skill` item
 *   without a model call; a workflow item recurring the second time leaves a backlog hint.
 */
import type { SessionAuth } from "eve/context";
import { describe, expect, it, type Mock, vi } from "vitest";

import { createImprovementSignalHandlers } from "./improvement-signals.js";
import { createReflectionRateLimiter, parseReflection } from "./reflection.js";
import type { TurnEvidence } from "./turn-evidence.js";

const evidence: TurnEvidence = {
  failedTools: [{ code: "AGENT_IMAGE_PROVIDER_FAILED", message: "упал", toolName: "generate_image" }],
  loadedSkills: [],
  stepCount: 2,
  toolNames: ["generate_image", "remember"],
  turnFailure: null,
};

describe("parseReflection", () => {
  it("keeps valid items and strips tools and codes absent from the evidence", () => {
    const items = parseReflection(JSON.stringify({ items: [
      { category: "tool_error", errorCode: "AGENT_IMAGE_PROVIDER_FAILED", priority: "high", summary: "Провайдер картинок падает", toolName: "generate_image" },
      { category: "workflow", errorCode: "MADE_UP", priority: "low", summary: "Лишний вызов", toolName: "bash" },
      { category: "nonsense", priority: "low", summary: "x" },
      { category: "prompt", priority: "urgent", summary: "x" },
    ] }), evidence);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ errorCode: "AGENT_IMAGE_PROVIDER_FAILED", toolName: "generate_image" });
    expect(items[1]).toMatchObject({ errorCode: null, toolName: null });
  });

  it("returns an empty list for prose or broken JSON", () => {
    expect(parseReflection("Ничего примечательного", evidence)).toEqual([]);
    expect(parseReflection("{\"items\": [", evidence)).toEqual([]);
  });
});

describe("createReflectionRateLimiter", () => {
  it("admits the hourly budget and refuses the rest until the window slides", () => {
    const limiter = createReflectionRateLimiter(2);
    const now = new Date("2026-09-05T12:00:00Z");
    expect(limiter.admit("f", now)).toBe(true);
    expect(limiter.admit("f", now)).toBe(true);
    expect(limiter.admit("f", now)).toBe(false);
    expect(limiter.admit("g", now)).toBe(true);
    expect(limiter.admit("f", new Date(now.getTime() + 3_600_001))).toBe(true);
  });
});

function ctx(attributes: Record<string, unknown>, channelKind = "channel:telegram") {
  return {
    channel: { kind: channelKind },
    session: {
      auth: { current: { attributes, authenticator: "telegram", principalId: "user-1", principalType: "user" }, initiator: null } as unknown as SessionAuth,
      id: "eve-1",
    },
  };
}

function recorded(recurrenceCount: number) {
  return { item: { recurrenceCount }, recurred: recurrenceCount > 1 };
}

type Dependencies = Parameters<typeof createImprovementSignalHandlers>[0];

function dependencies(overrides: Partial<Record<keyof Dependencies, Mock>> = {}) {
  return {
    conversationId: vi.fn().mockResolvedValue("conversation-1"),
    generate: vi.fn().mockResolvedValue("{\"items\":[]}"),
    isAuthoredSkill: vi.fn().mockResolvedValue(false),
    record: vi.fn().mockResolvedValue(recorded(1)),
    recordSkillOutcome: vi.fn().mockResolvedValue({ usageFound: true }),
    saveHint: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("createImprovementSignalHandlers", () => {
  it("reflects on a failed tool in an external group and records the item", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const record = vi.fn().mockResolvedValue(recorded(1));
    const generate = vi.fn().mockResolvedValue(JSON.stringify({ items: [
      { category: "tool_error", errorCode: "AGENT_IMAGE_PROVIDER_FAILED", priority: "medium", summary: "Провайдер картинок падает", toolName: "generate_image" },
    ] }));
    const handlers = createImprovementSignalHandlers(dependencies({ generate, record }));
    const context = ctx({ familyId: "family-1", groupType: "external", telegramChatType: "supergroup" });

    handlers.actionsRequested({ data: { actions: [{ callId: "c1", kind: "tool-call", toolName: "generate_image" }], turnId: "t1" } }, context);
    handlers.actionResult({ data: { error: { code: "AGENT_IMAGE_PROVIDER_FAILED", message: "упал" }, result: { callId: "c1", kind: "tool-result", toolName: "generate_image" }, status: "failed", turnId: "t1" } }, context);
    await handlers.turnCompleted({ data: { turnId: "t1" } }, context);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]?.[0]).toContain("\"chatKind\":\"external\"");
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      category: "tool_error",
      familyId: "family-1",
      priority: "medium",
      summary: "Провайдер картинок падает",
    }));
    expect(record.mock.calls[0]?.[0].evidence).toMatchObject({ eveSessionId: "eve-1", eveTurnId: "t1", toolName: "generate_image" });
  });

  it("stays quiet for a light turn and for a silent memory review", async () => {
    const record = vi.fn();
    const generate = vi.fn();
    const handlers = createImprovementSignalHandlers(dependencies({ generate, record }));
    const context = ctx({ familyId: "family-1", telegramChatType: "private" });
    handlers.actionsRequested({ data: { actions: [{ callId: "c1", kind: "tool-call", toolName: "remember" }], turnId: "t1" } }, context);
    await handlers.turnCompleted({ data: { turnId: "t1" } }, context);

    const review = ctx({ familyId: "family-1", memoryReviewBatchId: "batch-1", memoryReviewMode: "background", telegramChatType: "private" });
    handlers.actionsRequested({ data: { actions: [{ callId: "c2", kind: "tool-call", toolName: "remember" }], turnId: "t2" } }, review);
    handlers.actionResult({ data: { error: { code: "X", message: "" }, result: { callId: "c2", kind: "tool-result", toolName: "remember" }, status: "failed", turnId: "t2" } }, review);
    await handlers.turnCompleted({ data: { turnId: "t2" } }, review);

    expect(generate).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("marks a loaded authored skill failed and records a skill item without the model", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const deps = dependencies({
      isAuthoredSkill: vi.fn().mockImplementation(async (_familyId: string, name: string) => name === "birthday-card"),
    });
    const handlers = createImprovementSignalHandlers(deps);
    const context = ctx({ familyId: "family-1", groupType: "family_private", telegramChatType: "supergroup" });

    handlers.actionsRequested({ data: { actions: [
      { input: { skill: "birthday-card" }, kind: "load-skill" },
      { input: { skill: "imagegen" }, kind: "load-skill" },
    ], turnId: "t1" } }, context);
    handlers.actionsRequested({ data: { actions: [{ callId: "c1", kind: "tool-call", toolName: "generate_image" }], turnId: "t1" } }, context);
    handlers.actionResult({ data: { error: { code: "AGENT_IMAGE_PROVIDER_FAILED", message: "упал" }, result: { callId: "c1", kind: "tool-result", toolName: "generate_image" }, status: "failed", turnId: "t1" } }, context);
    await handlers.turnCompleted({ data: { turnId: "t1" } }, context);

    expect(deps.isAuthoredSkill).toHaveBeenCalledWith("family-1", "birthday-card");
    expect(deps.isAuthoredSkill).toHaveBeenCalledWith("family-1", "imagegen");
    expect(deps.recordSkillOutcome).toHaveBeenCalledTimes(1);
    expect(deps.recordSkillOutcome).toHaveBeenCalledWith({
      conversationId: "conversation-1", familyId: "family-1", name: "birthday-card",
      note: "generate_image: AGENT_IMAGE_PROVIDER_FAILED",
    });
    const skillItem = deps.record.mock.calls.find((call) => call[0].category === "skill")?.[0];
    expect(skillItem).toMatchObject({
      category: "skill", familyId: "family-1", priority: "medium",
      summary: "Навык birthday-card не справился: generate_image упал с AGENT_IMAGE_PROVIDER_FAILED",
    });
    expect(skillItem.evidence).toMatchObject({ eveTurnId: "t1", skillName: "birthday-card" });
    expect(skillItem.fingerprint).toMatch(/^[0-9a-f]{16}$/u);
    // The model reflection still runs for the failed tool, with the loaded skills in its facts.
    expect(deps.generate).toHaveBeenCalledTimes(1);
    expect(deps.generate.mock.calls[0]?.[0]).toContain("\"loadedSkills\":[\"birthday-card\",\"imagegen\"]");
    expect(deps.saveHint).not.toHaveBeenCalled();
  });

  it("does not guess a usage when the conversation of the turn is unknown", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const deps = dependencies({
      conversationId: vi.fn().mockResolvedValue(null),
      isAuthoredSkill: vi.fn().mockResolvedValue(true),
    });
    const handlers = createImprovementSignalHandlers(deps);
    const context = ctx({ familyId: "family-1", telegramChatType: "private" });

    handlers.actionsRequested({ data: { actions: [{ input: { skill: "weekly-report" }, kind: "load-skill" }], turnId: "t1" } }, context);
    handlers.actionsRequested({ data: { actions: [{ callId: "c1", kind: "tool-call", toolName: "web_search" }], turnId: "t1" } }, context);
    handlers.actionResult({ data: { error: { code: "X", message: "" }, result: { callId: "c1", kind: "tool-result", toolName: "web_search" }, status: "failed", turnId: "t1" } }, context);
    await handlers.turnCompleted({ data: { turnId: "t1" } }, context);

    // Upstream 960c4b9: without a conversation the outcome landed on another chat's latest usage.
    expect(deps.recordSkillOutcome).not.toHaveBeenCalled();
    expect(deps.record).toHaveBeenCalledWith(expect.objectContaining({ category: "skill" }));
  });

  it("records a heavy turn with an authored skill as a failed outcome by step count", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const deps = dependencies({ isAuthoredSkill: vi.fn().mockResolvedValue(true) });
    const handlers = createImprovementSignalHandlers(deps);
    const context = ctx({ familyId: "family-1", telegramChatType: "private" });

    handlers.actionsRequested({ data: { actions: [{ input: { skill: "weekly-report" }, kind: "load-skill" }], turnId: "t1" } }, context);
    for (let step = 0; step < 8; step += 1) {
      handlers.actionsRequested({ data: { actions: [{ callId: `c${step}`, kind: "tool-call", toolName: "web_search" }], turnId: "t1" } }, context);
    }
    await handlers.turnCompleted({ data: { turnId: "t1" } }, context);

    expect(deps.recordSkillOutcome).toHaveBeenCalledWith(expect.objectContaining({ name: "weekly-report", note: "9 шагов инструментов" }));
    expect(deps.record).toHaveBeenCalledWith(expect.objectContaining({
      category: "skill", summary: "Навык weekly-report: ход занял 9 шагов инструментов",
    }));
  });

  it("leaves a backlog hint when a workflow item recurs the second time in a trusted chat", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const generate = vi.fn().mockResolvedValue(JSON.stringify({ items: [
      { category: "workflow", errorCode: null, priority: "low", summary: "Поиск расписания занимает шесть шагов", toolName: null },
    ] }));
    const record = vi.fn().mockResolvedValueOnce(recorded(2)).mockResolvedValueOnce(recorded(2)).mockResolvedValue(recorded(3));
    const deps = dependencies({ generate, record });
    const handlers = createImprovementSignalHandlers(deps);
    const trusted = ctx({ familyId: "family-1", telegramChatType: "private" });
    const external = ctx({ familyId: "family-1", groupType: "external", telegramChatType: "supergroup" });

    handlers.actionsRequested({ data: { actions: [{ callId: "c1", kind: "tool-call", toolName: "web_search" }], turnId: "t1" } }, trusted);
    handlers.actionResult({ data: { error: { code: "X", message: "" }, result: { callId: "c1", kind: "tool-result", toolName: "web_search" }, status: "failed", turnId: "t1" } }, trusted);
    await handlers.turnCompleted({ data: { turnId: "t1" } }, trusted);
    expect(deps.saveHint).toHaveBeenCalledTimes(1);
    expect(deps.saveHint).toHaveBeenCalledWith({
      conversationId: "conversation-1", eveSessionId: "eve-1", eveTurnId: "t1", familyId: "family-1",
      kind: "backlog", summary: "Поиск расписания занимает шесть шагов",
    });

    // An external group gets no hint even on the second recurrence; a third recurrence is silent too.
    handlers.actionsRequested({ data: { actions: [{ callId: "c2", kind: "tool-call", toolName: "web_search" }], turnId: "t2" } }, external);
    handlers.actionResult({ data: { error: { code: "X", message: "" }, result: { callId: "c2", kind: "tool-result", toolName: "web_search" }, status: "failed", turnId: "t2" } }, external);
    await handlers.turnCompleted({ data: { turnId: "t2" } }, external);
    handlers.actionsRequested({ data: { actions: [{ callId: "c3", kind: "tool-call", toolName: "web_search" }], turnId: "t3" } }, trusted);
    handlers.actionResult({ data: { error: { code: "X", message: "" }, result: { callId: "c3", kind: "tool-result", toolName: "web_search" }, status: "failed", turnId: "t3" } }, trusted);
    await handlers.turnCompleted({ data: { turnId: "t3" } }, trusted);
    expect(deps.saveHint).toHaveBeenCalledTimes(1);
  });
});
