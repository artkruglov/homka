/**
 * Russian Telegram interface tests.
 *
 * Constructs covered:
 * - Approval prompts and buttons hide technical tool names from users.
 * - Policy updates disclose the complete replacement policy and non-disconnection warning.
 * - Freeform prompts and terminal errors use clear Russian text.
 */
import { describe, expect, it } from "vitest";

import {
  formatTelegramSessionFailure,
  formatTelegramTurnFailure,
  isUnrecoverableHistoryFailure,
  localizeTelegramInputRequest,
  localizeTelegramReplyMarkup,
} from "./telegram-interface.js";

describe("Telegram interface localization", () => {
  it("localizes a known tool approval without changing response identifiers", () => {
    const request = localizeTelegramInputRequest({
      action: {
        callId: "call-1",
        input: { action: "register" },
        kind: "tool-call" as const,
        toolName: "manage_telegram_group",
      },
      display: "confirmation" as const,
      kind: "tool-approval" as const,
      options: [
        { id: "approve", label: "Yes", style: "primary" as const },
        { id: "cancel", label: "No", style: "default" as const },
      ],
      prompt: "Approve tool call: manage_telegram_group",
      requestId: "request-1",
    });

    expect(request.prompt).toBe(
      "Подтверждение: подключить Telegram-группу. Если чат уже подключён с другим типом, его история, workspace, память и сессии будут безвозвратно удалены.\n\nДействие будет выполнено один раз. Автоматического повтора при ошибке не будет.",
    );
    expect(request.options).toEqual([
      { id: "approve", label: "Да, подтвердить", style: "primary" },
      { id: "cancel", label: "Нет, отменить", style: "default" },
    ]);
  });

  it("describes the external group file removal that only exists outside the tools directory", () => {
    const request = localizeTelegramInputRequest({
      action: {
        callId: "call-1",
        input: { path: "notes/plan.md" },
        kind: "tool-call" as const,
        toolName: "remove_group_file",
      },
      display: "confirmation" as const,
      kind: "tool-approval" as const,
      options: [
        { id: "approve", label: "Yes" },
        { id: "cancel", label: "No" },
      ],
      prompt: "Approve tool call: remove_group_file",
      requestId: "request-file",
    });

    // Единственный разрушительный инструмент внешней группы живёт вне agent/lib/tools/,
    // поэтому его окно проверяется явно.
    expect(request.prompt).toBe(
      "Подтверждение: удалить файл внешней группы.\n\nПуть: notes/plan.md\n\n" +
        "Действие будет выполнено один раз. Автоматического повтора при ошибке не будет.",
    );
    expect(request.options).toEqual([
      { id: "approve", label: "Да, подтвердить" },
      { id: "cancel", label: "Нет, отменить" },
    ]);
  });

  it("leaves a framework session-limit request unrewritten but localizes its buttons", () => {
    const request = localizeTelegramInputRequest({
      action: {
        callId: "call-1",
        input: { limit: 1_000_000, usedTokens: 1_000_123 },
        kind: "tool-call" as const,
        toolName: "session_limit_continuation",
      },
      display: "confirmation" as const,
      kind: "session-limit" as const,
      options: [
        { id: "continue", label: "Approve" },
        { id: "stop", label: "Stop" },
      ],
      prompt: "Session limit reached",
      requestId: "request-limit",
    });

    // Nothing is executed by a budget prompt, so neither its text nor a consequence may be invented.
    expect(request.prompt).toBe("Session limit reached");
    expect(request.prompt).not.toContain("будет выполнено один раз");
    expect(request.prompt).not.toContain("usedTokens");
    expect(request.options).toEqual([
      { id: "continue", label: "Продолжить" },
      { id: "stop", label: "Остановить" },
    ]);
  });

  it("uses a generic Russian prompt for an unknown tool", () => {
    const request = localizeTelegramInputRequest({
      action: { callId: "call-1", input: {}, kind: "tool-call" as const, toolName: "future_tool" },
      display: "confirmation" as const,
      kind: "tool-approval" as const,
      options: [
        { id: "approve", label: "Yes" },
        { id: "cancel", label: "No" },
      ],
      prompt: "Approve tool call: future_tool",
      requestId: "request-1",
    });

    expect(request.prompt).toBe(
      "Подтверждение: выполнение действия.\n\nДействие будет выполнено один раз. Автоматического повтора при ошибке не будет.",
    );
    expect(request.prompt).not.toContain("future_tool");
  });

  it("localizes Telegram group removal as a destructive approval", () => {
    const request = localizeTelegramInputRequest({
      action: {
        callId: "call-1",
        input: { action: "remove", telegramChatId: "-1001" },
        kind: "tool-call" as const,
        toolName: "manage_telegram_group",
      },
      display: "confirmation" as const,
      kind: "tool-approval" as const,
      options: [
        { id: "approve", label: "Yes", style: "danger" as const },
        { id: "cancel", label: "No" },
      ],
      prompt: "Approve tool call",
      requestId: "request-1",
    });

    expect(request.prompt).toBe(
      "Подтверждение: удалить регистрацию Telegram-группы и связанные данные Osinara. Бот останется участником Telegram-чата.\n\nTelegram chat ID: -1001\n\nДействие будет выполнено один раз. Автоматического повтора при ошибке не будет.",
    );
  });

  it("shows what a skill publication changes before approval", () => {
    const request = localizeTelegramInputRequest({
      action: {
        callId: "call-skill-publish",
        input: {
          action: "publish",
          changeNote: "Первая версия",
          description: "Открытка к празднику через Flux",
          files: { "references/flux-card.md": "…" },
          markdown: "## Когда применять\nКогда просят открытку.\n## Шаги\n1. `generate_image`",
          name: "birthday-card",
          trialRequest: "Сделай открытку Жене",
          trialSummary: "Сделала открытку для Жени",
          trials: [{ exampleId: "e1", summary: "Прошло" }, { exampleId: "e2", summary: "Прошло" }],
        },
        kind: "tool-call" as const,
        toolName: "manage_skill",
      },
      display: "confirmation" as const,
      kind: "tool-approval" as const,
      options: [],
      prompt: "Approve tool call",
      requestId: "request-skill-publish",
    });

    expect(request.prompt).toContain("Подтверждение: опубликовать собственный навык.");
    expect(request.prompt).toContain("Навык: birthday-card");
    expect(request.prompt).toContain("Описание: Открытка к празднику через Flux");
    expect(request.prompt).toContain("Пробный запрос: Сделай открытку Жене");
    expect(request.prompt).toContain("Пробный прогон: Сделала открытку для Жени");
    expect(request.prompt).toContain("Прогнано примеров: 2");
    expect(request.prompt).toContain("Файлы: references/flux-card.md");
    expect(request.prompt).toContain("Текст навыка: ## Когда применять");
  });

  it("shows the exact one-time reminder update before approval", () => {
    const request = localizeTelegramInputRequest({
      action: {
        callId: "call-reminder-update",
        input: {
          action: "update",
          id: "00000000-0000-4000-8000-000000000001",
          recurrence: null,
          scope: "family",
          timezone: "UTC",
        },
        kind: "tool-call" as const,
        toolName: "manage_reminder",
      },
      display: "confirmation" as const,
      kind: "tool-approval" as const,
      options: [],
      prompt: "Approve tool call",
      requestId: "request-reminder-update",
    });

    expect(request.prompt).toContain("Подтверждение: изменить напоминание.");
    expect(request.prompt).toContain("ID: 00000000-0000-4000-8000-000000000001");
    expect(request.prompt).toContain("Повторение: без повтора");
    expect(request.prompt).not.toContain("Часовой пояс");
    expect(request.prompt).not.toContain("Область");
  });

  it("shows reminder schedule parameters before create approval", () => {
    const request = localizeTelegramInputRequest({
      action: {
        callId: "call-reminder-create",
        input: {
          action: "create",
          content: "Позвонить врачу",
          firstRunAt: "2026-08-18T10:00:00+03:00",
          recurrence: { interval: 2, unit: "daily" },
          scope: "personal",
          timezone: "Europe/Moscow",
        },
        kind: "tool-call" as const,
        toolName: "manage_reminder",
      },
      display: "confirmation" as const,
      kind: "tool-approval" as const,
      options: [],
      prompt: "Approve tool call",
      requestId: "request-reminder-create",
    });

    expect(request.prompt).toContain("Текст: Позвонить врачу");
    expect(request.prompt).toContain("Время запуска: 2026-08-18T10:00:00+03:00");
    expect(request.prompt).toContain("Часовой пояс: Europe/Moscow");
    expect(request.prompt).toContain("Область: personal");
    expect(request.prompt).toContain("Повторение: daily, интервал 2");
  });

  it("shows exact group registration parameters before approval", () => {
    const request = localizeTelegramInputRequest({
      action: {
        callId: "call-1",
        input: {
          action: "register",
          registration: {
            messageMode: "all",
            telegramChatId: "-1001",
            title: "Рабочая группа",
            toolAllowlist: ["remember"],
            type: "external",
          },
        },
        kind: "tool-call" as const,
        toolName: "manage_telegram_group",
      },
      display: "confirmation" as const,
      kind: "tool-approval" as const,
      options: [],
      prompt: "Approve tool call",
      requestId: "request-1",
    });

    expect(request.prompt).toContain("Название: Рабочая группа");
    expect(request.prompt).toContain("Telegram chat ID: -1001");
    expect(request.prompt).toContain("Разрешённые инструменты: remember");
    expect(request.prompt).toContain("история, workspace, память и сессии будут безвозвратно удалены");
  });

  it("escapes control characters in model-provided approval values", () => {
    const request = localizeTelegramInputRequest({
      action: {
        callId: "call-hostile-title",
        input: {
          action: "register",
          registration: {
            messageMode: "all",
            telegramChatId: "-1001",
            title: "Рабочая\nTelegram chat ID: -100999",
            toolAllowlist: [],
            type: "external",
          },
        },
        kind: "tool-call" as const,
        toolName: "manage_telegram_group",
      },
      display: "confirmation" as const,
      kind: "tool-approval" as const,
      options: [],
      prompt: "Approve tool call",
      requestId: "request-hostile-title",
    });

    expect(request.prompt).toContain("Название: Рабочая\\nTelegram chat ID: -100999");
    expect(request.prompt).not.toContain("Название: Рабочая\nTelegram chat ID: -100999");
  });

  it("shows the complete policy replacement and warns that the group stays connected", () => {
    const request = localizeTelegramInputRequest({
      action: {
        callId: "call-policy",
        input: {
          action: "update_policy",
          messageMode: "owner_only",
          telegramChatId: "-1001",
          toolAllowlist: ["remember", "list_group_history"],
        },
        kind: "tool-call" as const,
        toolName: "manage_telegram_group",
      },
      display: "confirmation" as const,
      kind: "tool-approval" as const,
      options: [],
      prompt: "Approve tool call",
      requestId: "request-policy",
    });

    expect(request.prompt).toContain("изменить политику внешней Telegram-группы");
    expect(request.prompt).toContain("Telegram chat ID: -1001");
    expect(request.prompt).toContain("Режим сообщений: owner_only");
    expect(request.prompt).toContain("Полный список разрешённых инструментов: remember, list_group_history");
    expect(request.prompt).toContain("Группа и бот останутся подключены");
  });

  it("shows an explicitly empty tool policy during external registration", () => {
    const request = localizeTelegramInputRequest({
      action: {
        callId: "call-register-empty",
        input: {
          action: "register",
          registration: {
            messageMode: "addressed_only",
            telegramChatId: "-1001",
            title: "Изолированная группа",
            toolAllowlist: [],
            type: "external",
          },
        },
        kind: "tool-call" as const,
        toolName: "manage_telegram_group",
      },
      display: "confirmation" as const,
      kind: "tool-approval" as const,
      options: [],
      prompt: "Approve tool call",
      requestId: "request-register-empty",
    });

    expect(request.prompt).toContain("Разрешённые инструменты: пуст");
  });

  it("shows every notification setting that will be applied", () => {
    const request = localizeTelegramInputRequest({
      action: {
        callId: "call-notifications",
        input: {
          action: "set",
          quietEnd: null,
          quietStart: null,
          timezone: "Europe/Moscow",
        },
        kind: "tool-call" as const,
        toolName: "notification_settings",
      },
      display: "confirmation" as const,
      kind: "tool-approval" as const,
      options: [],
      prompt: "Approve tool call",
      requestId: "request-notifications",
    });

    expect(request.prompt).toContain("Часовой пояс: Europe/Moscow");
    expect(request.prompt).toContain("Тихие часы: отключены");
  });

  it("shows every changed memory field before edit approval", () => {
    const request = localizeTelegramInputRequest({
      action: {
        callId: "call-memory-edit",
        input: {
          action: "edit",
          content: "Исправленное значение",
          id: "00000000-0000-4000-8000-000000000001",
          kind: "preference",
          sensitivity: "sensitive",
        },
        kind: "tool-call" as const,
        toolName: "manage_memory",
      },
      display: "confirmation" as const,
      kind: "tool-approval" as const,
      options: [],
      prompt: "Approve tool call",
      requestId: "request-memory-edit",
    });

    expect(request.prompt).toContain("Новое значение: Исправленное значение");
    expect(request.prompt).toContain("Тип памяти: preference");
    expect(request.prompt).toContain("Чувствительность: sensitive");
  });

  it("shows every autonomous schedule parameter before create approval", () => {
    const request = localizeTelegramInputRequest({
      action: {
        callId: "call-schedule-create",
        input: {
          action: "create",
          firstRunAt: "2026-08-20T09:00:00+03:00",
          recurrence: { daysOfWeek: [1, 3, 5], interval: 1, kind: "weekly" },
          scenarioPrompt: "Собери новости и приложи источники.",
          scope: "personal",
          timezone: "Europe/Moscow",
          title: "Новости ИИ",
          userRequest: "По будням присылай новости ИИ",
        },
        kind: "tool-call" as const,
        toolName: "manage_agent_schedule",
      },
      display: "confirmation" as const,
      kind: "tool-approval" as const,
      options: [],
      prompt: "Approve tool call",
      requestId: "request-schedule-create",
    });

    expect(request.prompt).toContain("Название: Новости ИИ");
    expect(request.prompt).toContain("Назначение: По будням присылай новости ИИ");
    expect(request.prompt).toContain("Первый запуск: 2026-08-20T09:00:00+03:00");
    expect(request.prompt).toContain("Часовой пояс: Europe/Moscow");
    expect(request.prompt).toContain("Область: personal");
    expect(request.prompt).toContain("Периодичность: weekly, интервал 1, дни 1, 3, 5");
    expect(request.prompt).toContain("Сценарий: Собери новости и приложи источники.");
  });

  it("shows the external destination, history window, and capabilities before approval", () => {
    const request = localizeTelegramInputRequest({
      action: {
        callId: "call-external-schedule-create",
        input: {
          action: "create",
          capabilityAllowlist: ["send_workspace_file", "web_fetch"],
          firstRunAt: "2026-08-24T09:00:00+03:00",
          historyWindowDays: 7,
          recurrence: { daysOfWeek: [1], interval: 1, kind: "weekly" },
          scenarioPrompt: "Прочитай snapshot, создай HTML и отправь его в группу.",
          telegramChatId: "-1001234567890",
          timezone: "Europe/Moscow",
          title: "Недельная выжимка",
          userRequest: "Каждый понедельник присылай выжимку обсуждения за неделю",
        },
        kind: "tool-call" as const,
        toolName: "manage_external_group_schedule",
      },
      display: "confirmation" as const,
      kind: "tool-approval" as const,
      options: [],
      prompt: "Approve tool call",
      requestId: "request-external-schedule-create",
    });

    expect(request.prompt).toContain("создать автоматизацию внешней группы");
    expect(request.prompt).toContain("Telegram chat ID: -1001234567890");
    expect(request.prompt).toContain("Окно истории, дней: 7");
    expect(request.prompt).toContain("Разрешённые возможности: send_workspace_file, web_fetch");
    expect(request.prompt).toContain("Сценарий: Прочитай snapshot, создай HTML и отправь его в группу.");
  });

  it("localizes removal of a workspace Google profile", () => {
    const request = localizeTelegramInputRequest({
      action: {
        callId: "call-1",
        input: {
          action: "disconnect",
        },
        kind: "tool-call" as const,
        toolName: "manage_google_workspace_connection",
      },
      display: "confirmation" as const,
      kind: "tool-approval" as const,
      options: [],
      prompt: "Approve tool call",
      requestId: "request-google",
    });

    expect(request.prompt).toContain("отключить Google Workspace от текущей области");
  });

  it("localizes the freeform answer placeholder", () => {
    expect(
      localizeTelegramReplyMarkup({
        force_reply: true,
        input_field_placeholder: "Type your answer",
        selective: true,
      }),
    ).toEqual({
      force_reply: true,
      input_field_placeholder: "Введите ответ",
      selective: true,
    });
  });

  it("renders safe Russian terminal errors with support references", () => {
    const details = { errorId: "47dae564-7b24-497b-a1b7-69b8fcfdf92c", internal: "secret" };

    const turnMessage = formatTelegramTurnFailure({
      code: "AGENT_TOOL_CALL_FAILED",
      details,
    });
    const sessionMessage = formatTelegramSessionFailure({
      code: "AGENT_SESSION_FAILED",
      details,
    });

    expect(turnMessage).toContain("Не удалось выполнить запрос");
    expect(turnMessage).toContain("Код: AGENT_TOOL_CALL_FAILED");
    expect(turnMessage).toContain("Номер ошибки: 47dae564-7b24-497b-a1b7-69b8fcfdf92c");
    expect(sessionMessage).toContain("Не удалось продолжить этот диалог");
    expect(sessionMessage).not.toContain("secret");
  });

  it("shows the actionable schedule input explanation without internal details", () => {
    const turnMessage = formatTelegramTurnFailure({
      code: "AGENT_SCHEDULE_INPUT_INVALID",
      message: "AGENT_SCHEDULE_INPUT_INVALID: Для daily recurrence передайте recurrence: {\"kind\":\"daily\",\"interval\":1}",
    });

    expect(turnMessage).toContain("Для daily recurrence передайте recurrence");
    expect(turnMessage).toContain("Код: AGENT_SCHEDULE_INPUT_INVALID");
    expect(turnMessage).not.toContain("stack");
  });

  it("shows actionable input explanations for every validated model payload", () => {
    const turnMessage = formatTelegramTurnFailure({
      code: "AGENT_REMINDER_INPUT_INVALID",
      message: "AGENT_REMINDER_INPUT_INVALID: Для recurrence передайте null или объект {\"unit\":\"weekly\",\"interval\":1}",
    });

    expect(turnMessage).toContain("Для recurrence передайте null");
    expect(turnMessage).toContain("Код: AGENT_REMINDER_INPUT_INVALID");
  });

  it("names a poisoned history and its recovery for the person", () => {
    const data = {
      code: "MODEL_CALL_FAILED",
      details: {
        errorId: "a8c3ddd0-02b4-42ce-b017-ccfc629b6e73",
        message: "AI_MissingToolResultsError: Tool result is missing for tool call call_03.",
      },
    };

    expect(isUnrecoverableHistoryFailure(data)).toBe(true);
    expect(isUnrecoverableHistoryFailure({ code: "MODEL_CALL_FAILED", details: { errorId: "x" } })).toBe(false);
    expect(formatTelegramTurnFailure(data)).toContain("следующее сообщение начнёт новый контекст");
  });

  it("keeps generic model failures from exposing internals", () => {
    const turnMessage = formatTelegramTurnFailure({
      code: "MODEL_CALL_FAILED",
      details: {
        errorId: "8c4eebf2-a386-4dcb-913d-4b5a28edee2f",
        raw: "<think>secret reasoning</think>",
      },
      message:
        "AGENT_MINIMAX_REASONING_CONTRACT_VIOLATION: Модель вернула внутреннее рассуждение в тексте ответа",
    });

    expect(turnMessage).toContain("Не удалось выполнить запрос");
    expect(turnMessage).toContain("Модель не смогла сформировать завершённый ответ");
    expect(turnMessage).toContain("Код: MODEL_CALL_FAILED");
    expect(turnMessage).toContain("Номер ошибки: 8c4eebf2-a386-4dcb-913d-4b5a28edee2f");
    expect(turnMessage).not.toContain("AGENT_MINIMAX");
    expect(turnMessage).not.toContain("<think>");
    expect(turnMessage).not.toContain("secret reasoning");
  });

});
