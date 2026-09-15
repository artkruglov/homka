/**
 * Telegram approval presentation tests for external-group schedules.
 *
 * Constructs covered:
 * - Create approvals disclose the disabled-by-omission history snapshot setting.
 * - Update approvals do not present an omitted history field as a requested change.
 */
import { describe, expect, it } from "vitest";

import { localizeTelegramInputRequest } from "./telegram-interface.js";

function approval(action: "create" | "update") {
  return localizeTelegramInputRequest({
    action: {
      callId: `call-external-schedule-${action}`,
      input: action === "create"
        ? {
            action,
            capabilityAllowlist: [],
            firstRunAt: "2026-08-24T09:00:00+03:00",
            recurrence: { interval: 1, kind: "daily" },
            scenarioPrompt: "Подготовь отчёт.",
            telegramChatId: "-1001234567890",
            timezone: "Europe/Moscow",
            title: "Ежедневный отчёт",
            userRequest: "Каждый день присылай отчёт",
          }
        : {
            action,
            id: "schedule-1",
            title: "Обновлённый отчёт",
          },
      kind: "tool-call" as const,
      toolName: "manage_external_group_schedule",
    },
    display: "confirmation" as const,
      kind: "tool-approval" as const,
    options: [],
    prompt: "Approve tool call",
    requestId: `request-external-schedule-${action}`,
  });
}

describe("external schedule approval presentation", () => {
  it("shows disabled history when create omits the optional window", () => {
    expect(approval("create").prompt).toContain("Окно истории: отключено");
  });

  it("does not imply a history change when update omits the window", () => {
    expect(approval("update").prompt).not.toContain("Окно истории");
  });
});
