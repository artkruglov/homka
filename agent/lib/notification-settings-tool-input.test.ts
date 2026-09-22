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

const { configureNotifications, getNotificationSettings, setCoach, setWeeklyReview } = vi.hoisted(() => ({
  configureNotifications: vi.fn(),
  getNotificationSettings: vi.fn(),
  setCoach: vi.fn(),
  setWeeklyReview: vi.fn(),
}));

vi.mock("./reminders/reminder-context.js", () => ({
  requireReminderAuthorization: vi.fn(() => ({
    telegramChatType: "private",
    userId: "user-1",
  })),
}));
vi.mock("./reminders/reminder-repository.js", () => ({
  reminderRepository: { configureNotifications, getNotificationSettings, setCoach, setWeeklyReview },
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
    expect(schema.properties.action?.enum).toEqual(["get", "set", "coach", "weekly_review"]);
  });

  it("turns the coach on or off without a button and only with an explicit value", async () => {
    setCoach.mockResolvedValue({ coachEnabled: true });

    expect(approvalFor({ action: "coach", coachEnabled: true })).toBe("not-applicable");
    await expect(notificationSettings.execute({ action: "coach", coachEnabled: true } as never, context))
      .resolves.toEqual({ coachEnabled: true });
    expect(setCoach).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1" }), true);
    expect(() => approvalFor({ action: "coach" })).toThrowError(/AGENT_NOTIFICATION_SETTINGS_INPUT_INVALID.*coachEnabled/u);
    expect(() => approvalFor({ action: "coach", coachEnabled: true, timezone: "UTC" }))
      .toThrowError(/AGENT_NOTIFICATION_SETTINGS_INPUT_INVALID/u);
  });

  it("turns the weekly review on or off without a button and only with an explicit value", async () => {
    setWeeklyReview.mockResolvedValue({ weeklyReviewEnabled: true });

    expect(approvalFor({ action: "weekly_review", weeklyReviewEnabled: true })).toBe("not-applicable");
    await expect(notificationSettings
      .execute({ action: "weekly_review", weeklyReviewEnabled: false } as never, context))
      .resolves.toEqual({ weeklyReviewEnabled: true });
    expect(setWeeklyReview).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1" }), false);
    expect(() => approvalFor({ action: "weekly_review" }))
      .toThrowError(/AGENT_NOTIFICATION_SETTINGS_INPUT_INVALID.*weeklyReviewEnabled/u);
    // Согласие на обзор не должно уметь заодно переписать коуча или часовой пояс.
    expect(() => approvalFor({ action: "weekly_review", weeklyReviewEnabled: true, coachEnabled: true }))
      .toThrowError(/AGENT_NOTIFICATION_SETTINGS_INPUT_INVALID/u);
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
      '"action":"weekly_review"',
      "weeklyReviewEnabled",
    ]) expect(description).toContain(fragment);
  });
});
