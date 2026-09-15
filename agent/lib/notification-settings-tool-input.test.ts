/**
 * Notification settings model-input contract tests.
 *
 * Constructs covered:
 * - Machine-visible required action enum in an object schema.
 * - Shared semantic validation before approval and execution.
 * - Explicit safe handling of MiniMax sibling-field materialization.
 * - Complete payload and bounded-correction guidance in the tool description.
 */
import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { configureNotifications, getNotificationSettings } = vi.hoisted(() => ({
  configureNotifications: vi.fn(),
  getNotificationSettings: vi.fn(),
}));

vi.mock("./reminders/reminder-context.js", () => ({
  requireReminderAuthorization: vi.fn(() => ({
    telegramChatType: "private",
    userId: "user-1",
  })),
}));
vi.mock("./reminders/reminder-repository.js", () => ({
  reminderRepository: { configureNotifications, getNotificationSettings },
}));

import notificationSettings from "./tools/notification_settings.js";

const context = { callId: "call-1" } as ToolContext;

function approvalFor(input: Record<string, unknown>) {
  return (notificationSettings.approval as (context: never) => unknown)(
    { toolInput: input } as never,
  );
}

describe("notification_settings model input", () => {
  beforeEach(() => {
    configureNotifications.mockReset();
    getNotificationSettings.mockReset();
    getNotificationSettings.mockResolvedValue({ timezone: "Europe/Moscow" });
  });

  it("publishes a required action enum in an object schema", () => {
    const schema = z.toJSONSchema(notificationSettings.inputSchema as z.ZodType) as {
      properties: Record<string, { enum?: string[] }>;
      required?: string[];
      type?: string;
    };

    expect(schema.type).toBe("object");
    expect(schema.required).toContain("action");
    expect(schema.properties.action?.enum).toEqual(["get", "set"]);
  });

  it("rejects the same incomplete set before HITL and execution", async () => {
    const invalid = { action: "set", timezone: "Europe/Moscow" };

    expect(() => approvalFor(invalid)).toThrowError(
      /AGENT_NOTIFICATION_SETTINGS_INPUT_INVALID.*quietStart/u,
    );
    await expect(notificationSettings.execute(invalid as never, context)).rejects.toThrowError(
      /AGENT_NOTIFICATION_SETTINGS_INPUT_INVALID.*quietStart/u,
    );
    expect(configureNotifications).not.toHaveBeenCalled();
  });

  it("ignores only known set siblings when MiniMax materializes them for get", async () => {
    const input = {
      action: "get",
      quietEnd: "08:00",
      quietStart: "22:00",
      timezone: "Europe/Moscow",
    } as const;

    expect(approvalFor(input)).toBe("not-applicable");
    await expect(notificationSettings.execute(input, context)).resolves.toEqual({
      timezone: "Europe/Moscow",
    });
    expect(getNotificationSettings).toHaveBeenCalledTimes(1);
    expect(configureNotifications).not.toHaveBeenCalled();
  });

  it("rejects unpublished fields before approval", () => {
    expect(() => approvalFor({ action: "get", timezoneId: "Europe/Moscow" })).toThrowError(
      /AGENT_NOTIFICATION_SETTINGS_INPUT_INVALID.*timezoneId/u,
    );
  });

  it("documents every payload field and its constraints without defaults", () => {
    const description = notificationSettings.description;

    for (const fragment of [
      '{"action":"get"}',
      '"action":"set"',
      "timezone",
      "quietStart",
      "quietEnd",
      "null",
      "ЧЧ:ММ",
      "Не угадывай",
    ]) expect(description).toContain(fragment);
  });
});
