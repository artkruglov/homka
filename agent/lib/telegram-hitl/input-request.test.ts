/**
 * Telegram HITL input rendering tests.
 *
 * Constructs covered:
 * - External groups reject framework session-budget prompts and questions before any side effect.
 * - `createTelegramInputRequestHandler`: persists approver identity before exposing buttons.
 * - Interactive and scheduled requests receive aliases without changing Eve's continuation hook.
 * - Long approval prompts are delivered completely before the actionable final message.
 * - Several approvals of one step share one prompt; each keeps its own evidence row.
 */
import type { SessionContext } from "eve/context";
import type { TelegramEventContext } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import { createTelegramInputRequestHandler } from "./input-request.js";

describe("createTelegramInputRequestHandler", () => {
  it.each([
    {
      kind: "session-limit",
      signal: "request kind",
      toolName: "manage_agent_schedule",
    },
    {
      kind: "tool-approval",
      signal: "synthetic tool name",
      toolName: "session_limit_continuation",
    },
  ])("rejects an external-group session-limit prompt by $signal before side effects", async ({
    kind,
    toolName,
  }) => {
    const parkSession = vi.fn();
    const present = vi.fn();
    const register = vi.fn();
    const registerMessageRoutes = vi.fn();
    const request = vi.fn();
    const handler = createTelegramInputRequestHandler({
      approvals: { register },
      parkSession,
      present,
      registerMessageRoutes,
    });
    const channel = {
      state: {
        botUsername: "osinara_bot",
        chatId: "-1001",
        chatType: "supergroup",
        conversationId: "77",
        hitlCallbacks: {},
        messageThreadId: null,
        nextHitlCallbackId: 0,
        pendingFreeformReplies: {},
        triggeringUserId: "101",
      },
      telegram: { request },
    } as unknown as TelegramEventContext;
    const ctx = {
      session: {
        auth: {
          current: {
            attributes: {
              applicationSessionId: "app-session-1",
              groupType: "external",
              telegramChatId: "-1001",
              telegramChatType: "supergroup",
              telegramConversationId: "00000000-0000-4000-8000-000000000077",
              telegramTimelineEntryId: "00000000-0000-4000-8000-000000000078",
              telegramUserId: "101",
            },
            authenticator: "telegram",
            principalId: "telegram:101",
            principalType: "user",
          },
          initiator: null,
        },
        id: "wrun_root",
        turn: { id: "turn-1", sequence: 1 },
      },
    } as unknown as SessionContext;

    await expect(handler({
      requests: [{
        action: {
          callId: "wrun_child:limit:input:36140505",
          input: { kind: "input", limit: 36_140_505, usedTokens: 36_140_505 },
          kind: "tool-call",
          toolName,
        },
        allowFreeform: false,
        display: "confirmation",
        kind,
        options: [
          { id: "continue", label: "Approve", style: "primary" },
          { id: "stop", label: "Stop", style: "danger" },
        ],
        prompt: "Approve a fresh token budget",
        requestId: "wrun_child:limit:input:36140505",
      }],
    } as never, channel, ctx)).rejects.toThrow("AGENT_EXTERNAL_SESSION_LIMIT_FORBIDDEN");
    expect(present).not.toHaveBeenCalled();
    expect(parkSession).not.toHaveBeenCalled();
    expect(registerMessageRoutes).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "question", signal: "request kind", toolName: "ask_question" },
    { kind: "tool-approval", signal: "question tool name", toolName: "ask_question" },
  ])("rejects an external-group question by $signal before the placeholder is posted", async ({
    kind,
    toolName,
  }) => {
    const parkSession = vi.fn();
    const present = vi.fn();
    const register = vi.fn();
    const registerMessageRoutes = vi.fn();
    const request = vi.fn();
    const handler = createTelegramInputRequestHandler({
      approvals: { register },
      parkSession,
      present,
      registerMessageRoutes,
    });
    const channel = {
      state: {
        botUsername: "osinara_bot",
        chatId: "-1001",
        chatType: "supergroup",
        conversationId: "77",
        hitlCallbacks: {},
        messageThreadId: null,
        nextHitlCallbackId: 0,
        pendingFreeformReplies: {},
        triggeringUserId: "101",
      },
      telegram: { request },
    } as unknown as TelegramEventContext;
    const ctx = {
      session: {
        auth: {
          current: {
            attributes: {
              applicationSessionId: "app-session-1",
              groupType: "external",
              telegramChatId: "-1001",
              telegramChatType: "supergroup",
              telegramUserId: "101",
            },
            authenticator: "telegram",
            principalId: "telegram:101",
            principalType: "user",
          },
          initiator: null,
        },
        id: "wrun_root",
        turn: { id: "turn-1", sequence: 1 },
      },
    } as unknown as SessionContext;

    await expect(handler({
      requests: [{
        action: { callId: "call-q", input: {}, kind: "tool-call", toolName },
        allowFreeform: true,
        display: "text",
        kind,
        options: [],
        prompt: "Уточните значение",
        requestId: "request-question",
      }],
    } as never, channel, ctx)).rejects.toThrow("AGENT_EXTERNAL_QUESTION_FORBIDDEN");
    // Nothing reaches the public chat: no "preparing a confirmation" placeholder, no parking.
    expect(present).not.toHaveBeenCalled();
    expect(parkSession).not.toHaveBeenCalled();
    expect(registerMessageRoutes).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("does not park a session when semantic presentation fails", async () => {
    const parkSession = vi.fn();
    const handler = createTelegramInputRequestHandler({
      approvals: { register: vi.fn() },
      parkSession,
      present: vi.fn().mockRejectedValue(new Error("presentation failed")),
      registerMessageRoutes: vi.fn(),
    });
    const channel = {
      state: {
        botUsername: "osinara_bot",
        chatId: "101",
        chatType: "private",
        conversationId: "77",
        hitlCallbacks: {},
        messageThreadId: null,
        nextHitlCallbackId: 0,
        pendingFreeformReplies: {},
        triggeringUserId: "101",
      },
      telegram: { request: vi.fn() },
    } as unknown as TelegramEventContext;
    const ctx = {
      session: {
        auth: {
          current: {
            attributes: {
              applicationSessionId: "app-session-1",
              telegramChatId: "101",
              telegramChatType: "private",
              telegramUserId: "101",
            },
            authenticator: "telegram",
            principalId: "user-1",
            principalType: "user",
          },
          initiator: null,
        },
        id: "wrun_hitl",
        turn: { id: "turn-1", sequence: 1 },
      },
    } as unknown as SessionContext;

    await expect(handler({
      requests: [{
        action: {
          callId: "call-1",
          input: { action: "create" },
          kind: "tool-call",
          toolName: "manage_agent_schedule",
        },
        display: "confirmation",
        kind: "tool-approval",
        options: [],
        prompt: "Approve tool call",
        requestId: "request-1",
      }],
    } as never, channel, ctx)).rejects.toThrow("presentation failed");
    expect(parkSession).not.toHaveBeenCalled();
    expect(channel.telegram.request).not.toHaveBeenCalled();
  });

  it("registers the expected approver and route before exposing callback buttons", async () => {
    const parkSession = vi.fn();
    const register = vi.fn();
    const registerMessageRoutes = vi.fn();
    const request = vi.fn().mockImplementation(async (method: string) => method === "sendMessage"
      ? { body: { ok: true, result: { message_id: 88 } }, ok: true, status: 200 }
      : { body: {}, ok: true, status: 200 });
    const handler = createTelegramInputRequestHandler({
      approvals: { register },
      parkSession,
      present: async (request) => request,
      registerMessageRoutes,
    });
    const channel = {
      continuationToken: "-1001:55:77",
      state: {
        botUsername: "osinara_bot",
        chatId: "-1001",
        chatType: "supergroup",
        conversationId: "77",
        hitlCallbacks: {},
        messageThreadId: 55,
        nextHitlCallbackId: 0,
        pendingFreeformReplies: {},
        triggeringUserId: "101",
      },
      telegram: { request },
    } as unknown as TelegramEventContext;
    const ctx = {
      session: {
        auth: {
          current: {
            attributes: {
              applicationSessionId: "app-session-1",
              groupType: "external",
              telegramChatId: "-1001",
              telegramChatType: "supergroup",
              telegramConversationId: "00000000-0000-4000-8000-000000000077",
              telegramReplyToMessageId: "77",
              telegramTimelineEntryId: "00000000-0000-4000-8000-000000000078",
              telegramUserId: "101",
            },
            authenticator: "telegram",
            principalId: "user-1",
            principalType: "user",
          },
          initiator: null,
        },
        id: "wrun_hitl",
        turn: { id: "turn-1", sequence: 1 },
      },
    } as unknown as SessionContext;

    await handler({
      requests: [{
        action: {
          callId: "call-1",
          input: { action: "create" },
          kind: "tool-call",
          toolName: "manage_reminder",
        },
        display: "confirmation",
        kind: "tool-approval",
        options: [
          { id: "approve", label: "Yes", style: "primary" },
          { id: "deny", label: "No", style: "default" },
        ],
        prompt: "Approve tool call",
        requestId: "request-1",
      }],
    } as never, channel, ctx);

    expect(parkSession).toHaveBeenCalledWith({
      applicationSessionId: "app-session-1",
      pendingRequestId: "request-1",
      requesterTelegramUserId: "101",
      requesterUserId: null,
    });
    expect(request).toHaveBeenCalledWith("sendMessage", expect.objectContaining({
      chat_id: "-1001",
      message_thread_id: 55,
      reply_parameters: { allow_sending_without_reply: true, message_id: 77 },
      text: "Подготавливаю безопасный запрос подтверждения.",
    }));
    expect(request.mock.calls[0]?.[1]).not.toHaveProperty("reply_markup");
    expect(registerMessageRoutes).toHaveBeenCalledWith(channel, ctx, ["88"]);
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      applicationSessionId: "app-session-1",
      telegramConversationId: "00000000-0000-4000-8000-000000000077",
      telegramTimelineEntryId: "00000000-0000-4000-8000-000000000078",
      callbackData: ["eve:0", "eve:1"],
      callbackOptions: [
        { callbackData: "eve:0", label: "Yes", optionId: "approve" },
        { callbackData: "eve:1", label: "No", optionId: "deny" },
      ],
      eveSessionId: "wrun_hitl",
      requestId: "request-1",
      promptText: "Approve tool call",
      telegramChatId: "-1001",
      telegramChatType: "supergroup",
      telegramMessageId: "88",
      telegramMessageThreadId: "55",
      telegramUserId: "101",
      toolCallId: "call-1",
      toolInputHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      toolName: "manage_reminder",
    }));
    expect(request).toHaveBeenCalledWith("editMessageText", {
      chat_id: "-1001",
      message_id: 88,
      message_thread_id: 55,
      reply_markup: expect.any(Object),
      text: expect.any(String),
    });
    expect(registerMessageRoutes.mock.invocationCallOrder[0]).toBeLessThan(
      register.mock.invocationCallOrder[0]!,
    );
    expect(register.mock.invocationCallOrder[0]).toBeLessThan(
      request.mock.invocationCallOrder[1]!,
    );
  });

  it("renders every approval of one step as a single prompt with shared buttons", async () => {
    const register = vi.fn();
    const request = vi.fn().mockImplementation(async (method: string) => method === "sendMessage"
      ? { body: { ok: true, result: { message_id: 90 } }, ok: true, status: 200 }
      : { body: {}, ok: true, status: 200 });
    const parkSession = vi.fn();
    const handler = createTelegramInputRequestHandler({
      approvals: { register },
      parkSession,
      present: async (request) => request,
      registerMessageRoutes: vi.fn(),
    });
    const channel = {
      continuationToken: "-1001:55:77",
      state: {
        botUsername: "osinara_bot",
        chatId: "-1001",
        chatType: "supergroup",
        conversationId: "77",
        hitlCallbacks: {},
        messageThreadId: 55,
        nextHitlCallbackId: 0,
        pendingFreeformReplies: {},
        triggeringUserId: "101",
      },
      telegram: { request },
    } as unknown as TelegramEventContext;
    const ctx = {
      session: {
        auth: {
          current: {
            attributes: {
              applicationSessionId: "app-session-1",
              telegramChatId: "-1001",
              telegramChatType: "supergroup",
              telegramUserId: "101",
            },
            authenticator: "telegram",
            principalId: "user-1",
            principalType: "user",
          },
          initiator: null,
        },
        id: "wrun_hitl",
        turn: { id: "turn-1", sequence: 1 },
      },
    } as unknown as SessionContext;
    const approval = (index: number) => ({
      action: {
        callId: `call-${index}`,
        input: { action: "approve", invitationId: `inv-${index}` },
        kind: "tool-call",
        toolName: "manage_family_invitation",
      },
      display: "confirmation",
      kind: "tool-approval",
      options: [
        { id: "approve", label: "Approve", style: "primary" },
        { id: "cancel", label: "Cancel", style: "default" },
      ],
      prompt: `Approve invitation ${index}`,
      requestId: `request-${index}`,
    });

    await handler({ requests: [approval(1), approval(2), approval(3)] } as never, channel, ctx);

    // One Telegram message; Eve 0.40.0 resolves the batch only when one delivery answers all three.
    expect(request.mock.calls.filter(([method]) => method === "sendMessage")).toHaveLength(1);
    expect(parkSession).toHaveBeenCalledWith(expect.objectContaining({ pendingRequestId: "request-1" }));
    expect(register).toHaveBeenCalledTimes(3);
    const registered = register.mock.calls.map(([input]) => input as Record<string, unknown>);
    expect(registered.map((input) => input.requestId)).toEqual(["request-1", "request-2", "request-3"]);
    expect(registered.map((input) => input.toolCallId)).toEqual(["call-1", "call-2", "call-3"]);
    expect(new Set(registered.map((input) => input.toolInputHash)).size).toBe(3);
    for (const input of registered) {
      expect(input).toMatchObject({
        callbackData: ["eve:0", "eve:1"],
        callbackOptions: [
          { callbackData: "eve:0", label: "Да, подтвердить все", optionId: "approve" },
          { callbackData: "eve:1", label: "Нет, отменить все", optionId: "cancel" },
        ],
        telegramMessageId: "90",
      });
      expect(input.promptText).toContain("Нужно подтвердить сразу 3 действия");
      expect(input.promptText).toContain("3. Approve invitation 3");
    }
    const edit = request.mock.calls.find(([method]) => method === "editMessageText")?.[1] as {
      text: string;
    };
    expect(edit.text).toContain("1. Approve invitation 1");
  });

  it("opens ForceReply only on the non-actionable placeholder for a freeform request", async () => {
    const register = vi.fn();
    const request = vi.fn().mockImplementation(async (method: string) => method === "sendMessage"
      ? { body: { ok: true, result: { message_id: 90 } }, ok: true, status: 200 }
      : { body: {}, ok: true, status: 200 });
    const handler = createTelegramInputRequestHandler({
      approvals: { register },
      parkSession: vi.fn(),
      present: async (request) => request,
      registerMessageRoutes: vi.fn(),
    });
    const channel = {
      state: {
        botUsername: "osinara_bot",
        chatId: "-1001",
        chatType: "supergroup",
        conversationId: "77",
        hitlCallbacks: {},
        messageThreadId: 55,
        nextHitlCallbackId: 0,
        pendingFreeformReplies: {},
        triggeringUserId: "101",
      },
      telegram: { request },
    } as unknown as TelegramEventContext;
    const ctx = {
      session: {
        auth: {
          current: {
            attributes: { applicationSessionId: "app-session-1", telegramUserId: "101" },
            authenticator: "telegram",
            principalId: "user-1",
            principalType: "user",
          },
          initiator: null,
        },
        id: "wrun_hitl",
        turn: { id: "turn-1", sequence: 1 },
      },
    } as unknown as SessionContext;

    await handler({
      requests: [{
        action: { callId: "call-1", input: {}, kind: "tool-call", toolName: "ask_question" },
        allowFreeform: true,
        display: "text",
        kind: "question",
        options: [],
        prompt: "Уточните значение",
        requestId: "request-freeform",
      }],
    } as never, channel, ctx);

    expect(request).toHaveBeenCalledWith("sendMessage", {
      chat_id: "-1001",
      message_thread_id: 55,
      reply_markup: expect.objectContaining({ force_reply: true }),
      text: "Подготавливаю безопасный запрос подтверждения.",
    });
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ callbackData: [] }));
    expect(request).toHaveBeenCalledWith(
      "editMessageText",
      expect.objectContaining({ text: "Уточните значение" }),
    );
  });

  it("registers the exact callback route for a scheduled request", async () => {
    const registerMessageRoutes = vi.fn();
    const request = vi.fn().mockImplementation(async (method: string) => method === "sendMessage"
      ? { body: { ok: true, result: { message_id: 91 } }, ok: true, status: 200 }
      : { body: {}, ok: true, status: 200 });
    const handler = createTelegramInputRequestHandler({
      approvals: { register: vi.fn() },
      parkSession: vi.fn(),
      present: async (input) => input,
      registerMessageRoutes,
    });
    const channel = {
      state: {
        botUsername: "osinara_bot",
        chatId: "101",
        chatType: "private",
        conversationId: null,
        hitlCallbacks: {},
        messageThreadId: null,
        nextHitlCallbackId: 0,
        pendingFreeformReplies: {},
        triggeringUserId: "101",
      },
      telegram: { request },
    } as unknown as TelegramEventContext;
    const ctx = {
      session: {
        auth: {
          current: {
            attributes: {
              applicationSessionId: "app-session-1",
              scheduledRunId: "run-1",
              telegramUserId: "101",
            },
            authenticator: "telegram",
            principalId: "user-1",
            principalType: "user",
          },
          initiator: null,
        },
        id: "wrun_scheduled_hitl",
        turn: { id: "turn-1", sequence: 1 },
      },
    } as unknown as SessionContext;

    await handler({
      requests: [{
        action: { callId: "call-1", input: {}, kind: "tool-call", toolName: "ask_question" },
        allowFreeform: true,
        display: "text",
        kind: "question",
        options: [],
        prompt: "Уточните значение",
        requestId: "request-scheduled",
      }],
    } as never, channel, ctx);

    expect(registerMessageRoutes).toHaveBeenCalledWith(channel, ctx, ["91"]);
  });

  it("shows every part of a long confirmation before exposing approval buttons", async () => {
    const longPrompt = `${"Начало и подробности операции. ".repeat(250)}КОНЕЦ_ПОЛНОГО_ТЕКСТА`;
    let nextMessageId = 100;
    const register = vi.fn();
    const registerMessageRoutes = vi.fn();
    const request = vi.fn().mockImplementation(async (method: string) => method === "sendMessage"
      ? { body: { ok: true, result: { message_id: nextMessageId++ } }, ok: true, status: 200 }
      : { body: {}, ok: true, status: 200 });
    const handler = createTelegramInputRequestHandler({
      approvals: { register },
      parkSession: vi.fn(),
      present: async (input) => ({ ...input, prompt: longPrompt }),
      registerMessageRoutes,
    });
    const channel = {
      state: {
        botUsername: "osinara_bot",
        chatId: "101",
        chatType: "private",
        conversationId: "77",
        hitlCallbacks: {},
        messageThreadId: null,
        nextHitlCallbackId: 0,
        pendingFreeformReplies: {},
        triggeringUserId: "101",
      },
      telegram: { request },
    } as unknown as TelegramEventContext;
    const ctx = {
      session: {
        auth: {
          current: {
            attributes: {
              applicationSessionId: "app-session-1",
              telegramChatId: "101",
              telegramChatType: "private",
              telegramUserId: "101",
            },
            authenticator: "telegram",
            principalId: "user-1",
            principalType: "user",
          },
          initiator: null,
        },
        id: "wrun_long_hitl",
        turn: { id: "turn-long", sequence: 1 },
      },
    } as unknown as SessionContext;

    await handler({
      requests: [{
        action: {
          callId: "call-long",
          input: { action: "update" },
          kind: "tool-call",
          toolName: "manage_agent_schedule",
        },
        display: "confirmation",
        kind: "tool-approval",
        options: [
          { id: "approve", label: "Yes", style: "primary" },
          { id: "deny", label: "No", style: "default" },
        ],
        prompt: "Approve tool call",
        requestId: "request-long",
      }],
    } as never, channel, ctx);

    const sends = request.mock.calls.filter(([method]) => method === "sendMessage");
    expect(sends.length).toBeGreaterThan(1);
    expect(sends.slice(0, -1).map((call) => String(call[1].text)).join("\n"))
      .toContain("Начало и подробности операции");
    const edit = request.mock.calls.find(([method]) => method === "editMessageText");
    expect(edit?.[1]).toMatchObject({ reply_markup: expect.any(Object) });
    expect(String(edit?.[1].text)).toContain("КОНЕЦ_ПОЛНОГО_ТЕКСТА");
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ promptText: longPrompt }));
    expect(register.mock.invocationCallOrder[0]).toBeLessThan(
      request.mock.invocationCallOrder.at(-1)!,
    );
  });

  it("takes the chat type from the verified caller when the scheduled channel state has none", async () => {
    const register = vi.fn();
    const request = vi.fn().mockImplementation(async (method: string) => method === "sendMessage"
      ? { body: { ok: true, result: { message_id: 88 } }, ok: true, status: 200 }
      : { body: { ok: true, result: true }, ok: true, status: 200 });
    const handler = createTelegramInputRequestHandler({
      approvals: { register },
      parkSession: vi.fn(),
      present: async (request) => request,
      registerMessageRoutes: vi.fn(),
    });
    const channel = {
      state: {
        botUsername: "osinara_bot", chatId: "101", chatType: null, conversationId: "77", hitlCallbacks: {},
        messageThreadId: null, nextHitlCallbackId: 0, pendingFreeformReplies: {}, triggeringUserId: "101",
      },
      telegram: { request },
    } as unknown as TelegramEventContext;
    const ctx = {
      session: {
        auth: {
          current: {
            attributes: { applicationSessionId: "app-session-1", scheduledRunId: "run-1", telegramChatId: "101", telegramChatType: "private", telegramUserId: "101" },
            authenticator: "telegram", principalId: "user-1", principalType: "user",
          },
          initiator: null,
        },
        id: "wrun_scheduled", turn: { id: "turn-1", sequence: 1 },
      },
    } as unknown as SessionContext;

    // A native scheduled receive starts with no chat type in the channel state; the first question
    // or approval of the run used to fail before it was shown.
    await handler({
      requests: [{
        action: { callId: "call-1", input: { action: "create" }, kind: "tool-call", toolName: "manage_reminder" },
        display: "confirmation",
        kind: "tool-approval",
        options: [
          { id: "approve", label: "Yes", style: "primary" },
          { id: "deny", label: "No", style: "default" },
        ],
        prompt: "Approve tool call",
        requestId: "request-1",
      }],
    } as never, channel, ctx);

    expect(register).toHaveBeenCalledWith(expect.objectContaining({ telegramChatType: "private" }));
  });
});
