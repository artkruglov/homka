/**
 * Russian user-facing Telegram interface helpers.
 *
 * Exports:
 * - `localizeTelegramInputRequest`: translates approvals without changing response IDs.
 * - `localizeTelegramReplyMarkup`: translates the freeform answer placeholder.
 * - `TelegramInputRequest`: stable structural input used by the secure HITL renderer.
 * - Failure formatters: hide internals while preserving stable support references.
 */
import {
  buildApprovalMessage,
  genericApprovalFacts,
} from "./telegram-hitl/approval-message.js";


const TOOL_ACTION_LABELS: Readonly<Record<string, string>> = {
  remember: "сохранить запись в общей или чувствительной памяти",
  remove_group_file: "удалить файл внешней группы",
};

const MANAGED_ACTION_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  manage_google_workspace_connection: {
    disconnect: "отключить Google Workspace от текущей области",
  },
  manage_skill: {
    grant: "выдать собственный навык внешней группе",
    publish: "опубликовать собственный навык",
    retire: "убрать собственный навык из употребления",
    revoke: "забрать собственный навык у внешней группы",
    rollback: "откатить собственный навык к прежней версии",
  },
  manage_agent_schedule: {
    create: "создать агентное расписание",
    delete: "удалить агентное расписание",
    pause: "приостановить агентное расписание",
    resume: "возобновить агентное расписание",
    run_now: "запустить агентное расписание сейчас",
    update: "изменить агентное расписание",
  },
  manage_external_group_schedule: {
    create: "создать автоматизацию внешней группы",
    delete: "удалить автоматизацию внешней группы",
    pause: "приостановить автоматизацию внешней группы",
    resume: "возобновить автоматизацию внешней группы",
    run_now: "запустить автоматизацию внешней группы сейчас",
    update: "изменить автоматизацию внешней группы",
  },
  manage_family_invitation: {
    approve: "добавить участника в семью",
    create: "создать приглашение в семейного агента",
  },
  manage_memory: {
    delete: "удалить запись из памяти",
    edit: "исправить запись в памяти",
  },
  manage_reminder: {
    create: "создать напоминание",
    delete: "удалить напоминание",
    pause: "приостановить напоминание",
    resume: "возобновить напоминание",
    update: "изменить напоминание",
  },
  manage_telegram_group: {
    register:
      "подключить Telegram-группу. Если чат уже подключён с другим типом, его история, workspace, память и сессии будут безвозвратно удалены",
    remove:
      "удалить регистрацию Telegram-группы и связанные данные Osinara. Бот останется участником Telegram-чата",
    update_policy:
      "изменить политику внешней Telegram-группы. Группа и бот останутся подключены",
  },
  notification_settings: {
    set: "изменить настройки уведомлений",
  },
};

const ERROR_ID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu;

interface TelegramInputOption {
  description?: string;
  id: string;
  label: string;
  style?: "danger" | "default" | "primary";
}

type TelegramJsonValue =
  | boolean
  | null
  | number
  | string
  | { readonly [key: string]: TelegramJsonValue }
  | readonly TelegramJsonValue[];

export interface TelegramInputRequest {
  action: {
    callId: string;
    input: Record<string, TelegramJsonValue>;
    kind: "tool-call";
    toolName: string;
  };
  allowFreeform?: boolean;
  display?: "confirmation" | "select" | "text";
  /** Framework-owned source of the request. Only `tool-approval` is an application confirmation. */
  kind?: "question" | "session-limit" | "tool-approval";
  options?: TelegramInputOption[];
  prompt: string;
  requestId: string;
}

// Eve 0.40.0 emits `approve`/`cancel` for a tool approval and `continue`/`stop` for a session
// limit. No path emits `deny`, so no branch for it is kept.
const OPTION_LABELS: Readonly<Record<string, string>> = {
  approve: "Да, подтвердить",
  cancel: "Нет, отменить",
  continue: "Продолжить",
  stop: "Остановить",
};

interface FailureData {
  code: string;
  details?: Readonly<Record<string, unknown>>;
  message?: string;
}

function reminderRecurrenceLines(value: unknown): string[] {
  if (value === null) return ["Повторение: без повтора"];
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const recurrence = value as Record<string, unknown>;
  return typeof recurrence.unit === "string" && typeof recurrence.interval === "number"
    ? [`Повторение: ${recurrence.unit}, интервал ${recurrence.interval}`]
    : [];
}

function agentScheduleRecurrenceLines(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const recurrence = value as Record<string, unknown>;
  if (recurrence.kind === "once") return ["Периодичность: один раз"];
  if (typeof recurrence.kind !== "string" || typeof recurrence.interval !== "number") return [];
  const days = Array.isArray(recurrence.daysOfWeek) &&
      recurrence.daysOfWeek.every((day) => typeof day === "number")
    ? `, дни ${recurrence.daysOfWeek.join(", ")}`
    : "";
  return [`Периодичность: ${recurrence.kind}, интервал ${recurrence.interval}${days}`];
}

function approvalParameterLines(toolName: string, input: Record<string, unknown>): string[] {
  // Render only reviewed, user-understandable fields; unknown tool payloads remain hidden.
  const safe = (candidate: string): string => JSON.stringify(candidate).slice(1, -1);
  const value = (key: string): string | null => {
    const candidate = input[key];
    return typeof candidate === "string" && candidate ? safe(candidate) : null;
  };
  const line = (label: string, key: string): string[] => {
    const candidate = value(key);
    return candidate ? [`${label}: ${candidate}`] : [];
  };
  switch (toolName) {
    case "manage_telegram_group": {
      if (input.action === "remove") return line("Telegram chat ID", "telegramChatId");
      if (input.action === "update_policy") {
        // An empty array is still a complete replacement and must be visible before approval.
        const allowlist = Array.isArray(input.toolAllowlist)
          ? input.toolAllowlist.filter((item): item is string => typeof item === "string").join(", ")
          : null;
        return [
          ...line("Telegram chat ID", "telegramChatId"),
          ...line("Режим сообщений", "messageMode"),
          ...(allowlist !== null
            ? [`Полный список разрешённых инструментов: ${allowlist || "пуст"}`]
            : []),
        ];
      }
      const registration = input.registration;
      if (!registration || typeof registration !== "object") return [];
      const values = registration as Record<string, unknown>;
      const rawAllowlist = values.toolAllowlist;
      const hasAllowlist = Array.isArray(rawAllowlist);
      const allowlist = Array.isArray(rawAllowlist)
        ? rawAllowlist.filter((item): item is string => typeof item === "string").join(", ")
        : "";
      const registrationLine = (label: string, key: string): string[] => {
        const candidate = values[key];
        return typeof candidate === "string" && candidate ? [`${label}: ${safe(candidate)}`] : [];
      };
      return [
        ...registrationLine("Название", "title"),
        ...registrationLine("Telegram chat ID", "telegramChatId"),
        ...registrationLine("Тип группы", "type"),
        ...registrationLine("Режим сообщений", "messageMode"),
        ...(hasAllowlist ? [`Разрешённые инструменты: ${allowlist || "пуст"}`] : []),
      ];
    }
    case "manage_family_invitation":
      if (input.action === "create") return [];
      return [
        ...line("Кандидат", "candidateDisplayName"),
        ...line("Telegram user ID", "candidateTelegramUserId"),
      ];
    case "manage_memory":
      return input.action === "edit"
        ? [
            ...line("ID записи", "id"),
            ...line("Новое значение", "content"),
            ...line("Тип памяти", "kind"),
            ...line("Чувствительность", "sensitivity"),
          ]
        : line("ID записи", "id");
    case "remember":
      return [
        ...line("Область", "scope"),
        ...line("Содержимое", "content"),
        ...line("Чувствительность", "sensitivity"),
      ];
    case "manage_agent_schedule":
      return [
        ...line("ID", "id"),
        ...line("Название", "title"),
        ...line("Назначение", "userRequest"),
        ...line("Первый запуск", "firstRunAt"),
        ...line("Следующий запуск", "nextRunAt"),
        ...line("Часовой пояс", "timezone"),
        ...line("Область", "scope"),
        ...agentScheduleRecurrenceLines(input.recurrence),
        ...line("Сценарий", "scenarioPrompt"),
      ];
    case "manage_external_group_schedule": {
      const capabilities = Array.isArray(input.capabilityAllowlist)
        ? input.capabilityAllowlist.filter((item): item is string => typeof item === "string").join(", ")
        : null;
      return [
        ...line("ID", "id"),
        ...line("Telegram chat ID", "telegramChatId"),
        ...line("Название", "title"),
        ...line("Назначение", "userRequest"),
        ...line("Первый запуск", "firstRunAt"),
        ...line("Следующий запуск", "nextRunAt"),
        ...line("Часовой пояс", "timezone"),
        ...(typeof input.historyWindowDays === "number"
          ? [`Окно истории, дней: ${input.historyWindowDays}`]
          : input.historyWindowDays === null ||
              (input.action === "create" && input.historyWindowDays === undefined)
            ? ["Окно истории: отключено"]
            : []),
        ...(capabilities === null ? [] : [`Разрешённые возможности: ${capabilities || "нет"}`]),
        ...agentScheduleRecurrenceLines(input.recurrence),
        ...line("Сценарий", "scenarioPrompt"),
      ];
    }
    case "manage_reminder":
      return [
        ...line("ID", "id"),
        ...line("Текст", "content"),
        ...line("Время запуска", "firstRunAt"),
        ...line("Связанная задача", "taskId"),
        ...(input.action === "create" ? line("Часовой пояс", "timezone") : []),
        ...(input.action === "create" ? line("Область", "scope") : []),
        ...reminderRecurrenceLines(input.recurrence),
      ];
    case "manage_skill":
      return [
        ...line("Навык", "name"),
        ...(typeof input.version === "number" ? [`Вернуться к версии: ${input.version}`] : []),
        ...line("Описание", "description"),
        ...line("Что изменилось", "changeNote"),
        ...line("Пробный запрос", "trialRequest"),
        ...line("Пробный прогон", "trialSummary"),
        ...(Array.isArray(input.trials) ? [`Прогнано примеров: ${input.trials.length}`] : []),
        ...line("Группа", "group"),
        ...(typeof input.markdown === "string"
          ? [`Текст навыка: ${safe(input.markdown.split("\n").slice(0, 6).join(" ").slice(0, 300))}${input.markdown.length > 300 ? "…" : ""}`]
          : []),
        ...(input.files && typeof input.files === "object"
          ? [`Файлы: ${Object.keys(input.files as Record<string, unknown>).map(safe).join(", ") || "нет"}`]
          : []),
      ];
    case "remove_group_file":
      return line("Путь", "path");
    case "notification_settings":
      return [
        ...line("Часовой пояс", "timezone"),
        ...(input.quietStart === null && input.quietEnd === null
          ? ["Тихие часы: отключены"]
          : typeof input.quietStart === "string" && typeof input.quietEnd === "string"
          ? [`Тихие часы: ${safe(input.quietStart)}–${safe(input.quietEnd)}`]
          : []),
      ];
    default:
      return [];
  }
}

function approvalActionLabel(toolName: string, input: Record<string, unknown>): string | null {
  const direct = TOOL_ACTION_LABELS[toolName];
  if (direct) return direct;
  const action = input.action;
  return typeof action === "string" ? MANAGED_ACTION_LABELS[toolName]?.[action] ?? null : null;
}

function supportReference(details: FailureData["details"]): string | null {
  if (!details) return null;
  return ERROR_ID_PATTERN.exec(JSON.stringify(details))?.[0] ?? null;
}

/**
 * A tool call that never received its result poisons every later model call of the session: the
 * AI SDK refuses the prompt before the provider sees it. Only a new session recovers from that.
 */
export function isUnrecoverableHistoryFailure(data: FailureData): boolean {
  return data.code === "MODEL_CALL_FAILED" &&
    JSON.stringify(data.details ?? {}).includes("AI_MissingToolResultsError");
}

function publicFailureExplanation(data: FailureData): string | null {
  if (isUnrecoverableHistoryFailure(data)) {
    return "История этого разговора повреждена, поэтому следующее сообщение начнёт новый контекст.";
  }
  if (data.code === "MODEL_CALL_FAILED") {
    // The step guard is a blocking model, so Eve reports it as a model failure; the person needs
    // the actual reason, not a hint that the provider is down.
    if (JSON.stringify(data.details ?? {}).includes("AGENT_TURN_MODEL_STEP_LIMIT_EXCEEDED")) {
      return "Запрос потребовал слишком много шагов. Разбейте задачу на части и повторите.";
    }
    return "Модель не смогла сформировать завершённый ответ.";
  }
  // Validation errors are authored by application code and already contain safe Russian guidance.
  if (!data.code.endsWith("_INPUT_INVALID") || typeof data.message !== "string") return null;
  return data.message.replace(new RegExp(`^${data.code}:\\s*`, "u"), "");
}

export function localizeTelegramInputRequest<T extends TelegramInputRequest>(request: T): T {
  // Option IDs remain unchanged because Eve resolves callbacks by ID, not visible text.
  const options = request.options?.map((option) => ({
    ...option,
    label: OPTION_LABELS[option.id] ?? option.label,
  }));

  // Only an application tool approval gets the composed confirmation. A framework request such as
  // `session-limit` executes nothing, so its own prompt and consequence must not be rewritten.
  if (request.display !== "confirmation" || request.kind !== "tool-approval") {
    return options ? { ...request, options } : request;
  }

  const actionLabel = approvalActionLabel(request.action.toolName, request.action.input);
  const reviewed = approvalParameterLines(request.action.toolName, request.action.input);
  return {
    ...request,
    ...(options ? { options } : {}),
    prompt: buildApprovalMessage({
      actionLabel,
      // A reviewed tool that shows no parameters chose that deliberately. Only a tool with no
      // description at all falls back to bounded scalar fields instead of an empty confirmation.
      facts: reviewed.length || actionLabel !== null
        ? reviewed
        : genericApprovalFacts(request.action.input),
    }),
  };
}

export function localizeTelegramReplyMarkup(
  replyMarkup: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (replyMarkup?.force_reply !== true) return replyMarkup;
  return { ...replyMarkup, input_field_placeholder: "Введите ответ" };
}

export function formatTelegramTurnFailure(data: FailureData): string {
  const errorId = supportReference(data.details);
  const explanation = publicFailureExplanation(data);
  return [
    "Не удалось выполнить запрос.",
    ...(explanation ? [explanation] : []),
    "Попробуйте отправить сообщение ещё раз. Если ошибка повторится, сообщите код поддержке.",
    `Код: ${data.code}`,
    ...(errorId ? [`Номер ошибки: ${errorId}`] : []),
  ].join("\n\n");
}

export function formatTelegramSessionFailure(data: FailureData): string {
  const errorId = supportReference(data.details);
  return [
    "Не удалось продолжить этот диалог после ошибки.",
    "Отправьте новое сообщение, чтобы продолжить работу.",
    `Код: ${data.code}`,
    ...(errorId ? [`Номер ошибки: ${errorId}`] : []),
  ].join("\n\n");
}
