/**
 * Skill signal handler tests.
 *
 * Constructs covered:
 * - `load_skill` of a named skill in a trusted chat records a usage row; an external group records
 *   it against its own conversation; a member's private chat and a subagent do not.
 * - Four or more non-bookkeeping tool calls in one trusted turn save a hint with unique names.
 * - Bookkeeping tools, review sessions, scheduled runs and subagents never produce a hint.
 */
import type { SessionAuth } from "eve/context";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSkillSignalHandlers } from "./skill-signals.js";

function context(attributes: Record<string, unknown>, options: { channel?: string; sessionId?: string } = {}) {
  const auth: SessionAuth = {
    current: {
      attributes: { familyId: "family-1", telegramActorId: "101", telegramActorKind: "telegram_user", telegramUserId: "101", ...attributes },
      authenticator: "telegram",
      principalId: "user-1",
      principalType: "user",
    },
    initiator: null,
  };
  return { channel: { kind: options.channel ?? "channel:telegram" }, session: { auth, id: options.sessionId ?? "eve-1" } };
}

const FAMILY = { groupId: "group-1", groupType: "family_private", memoryScopes: ["family"], role: "member", telegramChatType: "supergroup" };
const OWNER = { memoryScopes: ["personal", "family"], role: "owner", telegramChatType: "private" };

function call(toolName: string) {
  return { callId: `c-${toolName}`, input: {}, kind: "tool-call", toolName };
}

describe("skill signals", () => {
  const dependencies = {
    conversationId: vi.fn(),
    groupConversationId: vi.fn(),
    recordUsage: vi.fn(),
    saveHint: vi.fn(),
  };

  beforeEach(() => {
    for (const mock of Object.values(dependencies)) mock.mockReset();
    dependencies.conversationId.mockResolvedValue("conversation-1");
    dependencies.groupConversationId.mockResolvedValue("conversation-group-2");
    dependencies.recordUsage.mockResolvedValue(true);
    dependencies.saveHint.mockResolvedValue(undefined);
  });

  it("records an observed authored-skill load in a trusted chat", async () => {
    const handlers = createSkillSignalHandlers(dependencies);

    await handlers.actionsRequested({ data: { actions: [
      { callId: "c1", input: { skill: "birthday-card" }, kind: "load-skill" },
    ], turnId: "turn_3" } }, context(FAMILY));

    expect(dependencies.conversationId).toHaveBeenCalledWith({ chatKind: "family", familyId: "family-1", userId: "user-1" });
    expect(dependencies.recordUsage).toHaveBeenCalledWith({
      conversationId: "conversation-1", eveSessionId: "eve-1", eveTurnId: "turn_3",
      familyId: "family-1", skillName: "birthday-card",
    });
  });

  it("ignores loads in a member's private chat and in a subagent", async () => {
    const handlers = createSkillSignalHandlers(dependencies);
    const memberPrivate = { memoryScopes: ["personal", "family"], role: "member", telegramChatType: "private" };
    const load = { callId: "c1", input: { skill: "birthday-card" }, kind: "load-skill" };

    await handlers.actionsRequested({ data: { actions: [load], turnId: "t" } }, context(memberPrivate));
    await handlers.actionsRequested({ data: { actions: [load], turnId: "t" } }, context(FAMILY, { channel: "subagent" }));

    expect(dependencies.recordUsage).not.toHaveBeenCalled();
  });

  it("records a load in an external group against the group's conversation and never hints there", async () => {
    const handlers = createSkillSignalHandlers(dependencies);
    const external = { groupId: "group-2", groupType: "external", memoryScopes: ["group"], role: "external", telegramChatType: "supergroup" };
    const load = { callId: "c1", input: { skill: "weekly-digest" }, kind: "load-skill" };

    await handlers.actionsRequested({ data: { actions: [load, call("web_search"), call("web_fetch"), call("bash"), call("write_file")], turnId: "t" } }, context(external));
    await handlers.turnCompleted({ data: { turnId: "t" } }, context(external));

    expect(dependencies.groupConversationId).toHaveBeenCalledWith("group-2");
    expect(dependencies.conversationId).not.toHaveBeenCalled();
    expect(dependencies.recordUsage).toHaveBeenCalledWith({
      conversationId: "conversation-group-2", eveSessionId: "eve-1", eveTurnId: "t",
      familyId: "family-1", skillName: "weekly-digest",
    });
    expect(dependencies.saveHint).not.toHaveBeenCalled();
  });

  it("saves a hint after four real tool calls in one trusted turn", async () => {
    const handlers = createSkillSignalHandlers(dependencies);
    const ctx = context(OWNER);

    await handlers.actionsRequested({ data: { actions: [call("web_search"), call("remember")], turnId: "turn_5" } }, ctx);
    await handlers.actionsRequested({ data: { actions: [call("web_search"), call("generate_image")], turnId: "turn_5" } }, ctx);
    await handlers.turnCompleted({ data: { turnId: "turn_5" } }, ctx);
    expect(dependencies.saveHint).not.toHaveBeenCalled();

    await handlers.actionsRequested({ data: { actions: [call("web_search"), call("web_fetch"), call("bash"), call("send_workspace_file")], turnId: "turn_6" } }, ctx);
    await handlers.turnCompleted({ data: { turnId: "turn_6" } }, ctx);

    expect(dependencies.saveHint).toHaveBeenCalledWith({
      conversationId: "conversation-1", eveSessionId: "eve-1", eveTurnId: "turn_6",
      familyId: "family-1", kind: "repeat", stepCount: 4, toolNames: ["web_search", "web_fetch", "bash", "send_workspace_file"],
    });
  });

  it("counts nothing for scheduled runs, review sessions and other sessions' turns", async () => {
    const handlers = createSkillSignalHandlers(dependencies);
    const heavy = { data: { actions: [call("a_b"), call("c_d"), call("e_f"), call("g_h")], turnId: "turn_1" } };

    await handlers.actionsRequested(heavy, context({ ...OWNER, scheduledRunId: "run-1" }));
    await handlers.turnCompleted({ data: { turnId: "turn_1" } }, context({ ...OWNER, scheduledRunId: "run-1" }));
    await handlers.actionsRequested(heavy, context({ ...FAMILY, memoryReviewMode: "background" }));
    await handlers.turnCompleted({ data: { turnId: "turn_1" } }, context({ ...FAMILY, memoryReviewMode: "background" }));
    await handlers.actionsRequested(heavy, context(OWNER, { sessionId: "eve-A" }));
    await handlers.turnCompleted({ data: { turnId: "turn_1" } }, context(OWNER, { sessionId: "eve-B" }));

    expect(dependencies.saveHint).not.toHaveBeenCalled();
  });
});
