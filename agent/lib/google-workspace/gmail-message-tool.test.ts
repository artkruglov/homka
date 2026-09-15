/**
 * Structured Gmail message mutation tool tests.
 *
 * Constructs covered:
 * - Every supported message-state action requires Eve HITL.
 * - The backend, not the model, compiles the exact gws argv after approval.
 * - Only the published action/messageId/profileRef contract reaches execution.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import manageGmailMessage, {
  createGmailMessageManager,
} from "../tools/manage_gmail_message.js";

function approvalFor(input: Record<string, unknown>) {
  return (manageGmailMessage as unknown as {
    approval: (context: { toolInput: Record<string, unknown> }) => unknown;
  }).approval({ toolInput: input });
}

describe("manage_gmail_message", () => {
  it("publishes only structured message-state actions", () => {
    const schema = z.toJSONSchema((manageGmailMessage as unknown as {
      inputSchema: Parameters<typeof z.toJSONSchema>[0];
    }).inputSchema) as { properties?: Record<string, unknown> };

    expect(schema.properties).toMatchObject({
      action: {
        enum: ["trash", "delete", "restore", "mark_read", "mark_unread"],
        type: "string",
      },
      messageId: { type: "string" },
      profileRef: { type: "string" },
    });
    expect(schema.properties).not.toHaveProperty("argv");
    for (const action of ["trash", "delete", "restore", "mark_read", "mark_unread"]) {
      expect(approvalFor({ action, messageId: "message-1", profileRef: "profile-1" }))
        .toBe("user-approval");
    }
  });

  it.each([
    ["trash", ["gmail", "users", "messages", "trash", "--params", '{"userId":"me","id":"18f1a2b3c4d"}']],
    ["delete", ["gmail", "users", "messages", "delete", "--params", '{"userId":"me","id":"18f1a2b3c4d"}']],
    ["restore", ["gmail", "users", "messages", "untrash", "--params", '{"userId":"me","id":"18f1a2b3c4d"}']],
    ["mark_read", ["gmail", "users", "messages", "modify", "--params", '{"userId":"me","id":"18f1a2b3c4d"}', "--json", '{"removeLabelIds":["UNREAD"]}']],
    ["mark_unread", ["gmail", "users", "messages", "modify", "--params", '{"userId":"me","id":"18f1a2b3c4d"}', "--json", '{"addLabelIds":["UNREAD"]}']],
  ] as const)(
    "compiles action=%s into one exact backend command",
    async (action, argv) => {
      const execute = vi.fn().mockResolvedValue({ completed: true });
      const manage = createGmailMessageManager({ execute });
      const ctx = { callId: "call-1" } as never;

      await expect(manage({
        action,
        messageId: "18f1a2b3c4d",
        profileRef: "profile-1",
      }, ctx)).resolves.toEqual({
        completed: true,
      });
      expect(execute).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledWith({
        argv: [...argv],
        expectedProfileRef: "profile-1",
      }, ctx);
    },
  );

  it("rejects unpublished input before execution", async () => {
    const execute = vi.fn();
    const manage = createGmailMessageManager({ execute });

    await expect(manage({
      action: "trash",
      argv: ["gmail"],
      messageId: "message-1",
      profileRef: "profile-1",
    } as never, {} as never)).rejects.toThrowError(/AGENT_GMAIL_MESSAGE_INPUT_INVALID/u);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects control characters inside messageId before metadata or execution", () => {
    expect(() => approvalFor({
      action: "trash",
      messageId: "message\nid",
      profileRef: "profile-1",
    })).toThrowError(/AGENT_GMAIL_MESSAGE_INPUT_INVALID/u);
  });

  it("rejects invisible format characters before preview can hide them", () => {
    expect(() => approvalFor({
      action: "trash",
      messageId: "message\u200Bid",
      profileRef: "profile-1",
    })).toThrowError(/AGENT_GMAIL_MESSAGE_INPUT_INVALID/u);
  });
});
