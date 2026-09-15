/**
 * Consolidated personal notification settings tool.
 *
 * Export:
 * - `notification_settings`: reads or updates timezone and quiet-hour policy.
 *
 * Key constructs:
 * - Object-shaped model schema publishes a required finite action discriminator.
 * - One semantic parser validates both approval and execution inputs.
 * - Input validation explains the exact quiet-hours contract before repository calls.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { AppError } from "../app-error.js";
import { requireReminderAuthorization } from "../reminders/reminder-context.js";
import { reminderRepository } from "../reminders/reminder-repository.js";
import {
  requireAction,
  requiredString,
  requireInputRecord,
  requireOnlyFields,
  toolInputError,
} from "../tool-input-validation.js";

const INPUT_ERROR_CODE = "AGENT_NOTIFICATION_SETTINGS_INPUT_INVALID";
const TOOL_ACTIONS = ["get", "set"] as const;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const TOP_LEVEL_FIELDS = ["action", "initiativeDailyLimit", "initiativeEnabled", "quietEnd",
  "quietStart", "timezone"] as const;

const nullableTimeSchema = z.union([z.string(), z.null()]).optional();
const notificationSettingsSchema = z.object({
  action: z.enum(TOOL_ACTIONS).describe("Обязательный action: get или set."),
  quietEnd: nullableTimeSchema.describe("Обязательно для action=set: ЧЧ:ММ или null."),
  quietStart: nullableTimeSchema.describe("Обязательно для action=set: ЧЧ:ММ или null."),
  timezone: z.string().optional().describe("Обязательный IANA timezone только для action=set."),
  initiativeEnabled: z.boolean().optional()
    .describe("Необязательно для action=set: false означает «не пиши мне первым»."),
  initiativeDailyLimit: z.number().optional()
    .describe("Необязательно для action=set: сколько раз в сутки можно написать первым, 0-20."),
}).strict();

function requiredNullableTime(input: Record<string, unknown>, key: "quietEnd" | "quietStart"): string | null {
  const value = input[key];
  if (value === null) return null;
  if (typeof value !== "string" || !TIME_PATTERN.test(value)) {
    toolInputError(
      INPUT_ERROR_CODE,
      `Поле ${key} должно быть null или временем в формате ЧЧ:ММ, например 22:00`,
    );
  }
  return value;
}

function optionalInitiativeLimit(input: Record<string, unknown>): number | undefined {
  const value = input["initiativeDailyLimit"];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 20) {
    toolInputError(INPUT_ERROR_CODE, "Поле initiativeDailyLimit должно быть целым числом от 0 до 20");
  }
  return value;
}

function optionalInitiativeEnabled(input: Record<string, unknown>): boolean | undefined {
  const value = input["initiativeEnabled"];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    toolInputError(INPUT_ERROR_CODE, "Поле initiativeEnabled должно быть true или false");
  }
  return value;
}

function requireSetInput(input: Record<string, unknown>) {
  requireOnlyFields(input, TOP_LEVEL_FIELDS, "action=set", INPUT_ERROR_CODE);
  const quietStart = requiredNullableTime(input, "quietStart");
  const quietEnd = requiredNullableTime(input, "quietEnd");
  const bothDisabled = quietStart === null && quietEnd === null;
  const bothConfigured = quietStart !== null && quietEnd !== null && quietStart !== quietEnd;
  if (!bothDisabled && !bothConfigured) {
    toolInputError(
      INPUT_ERROR_CODE,
      "Передайте quietStart и quietEnd вместе разными значениями ЧЧ:ММ либо оба null, чтобы отключить тихие часы",
    );
  }
  return {
    ...(optionalInitiativeEnabled(input) === undefined
      ? {} : { initiativeEnabled: optionalInitiativeEnabled(input) }),
    ...(optionalInitiativeLimit(input) === undefined
      ? {} : { initiativeDailyLimit: optionalInitiativeLimit(input) }),
    quietEnd,
    quietStart,
    timezone: requiredString(input, "timezone", INPUT_ERROR_CODE, "Europe/Moscow", { maxLength: 100 }),
  };
}

function requireNotificationSettingsInput(input: unknown) {
  const payload = requireInputRecord(input, "notification_settings", INPUT_ERROR_CODE);
  requireOnlyFields(payload, TOP_LEVEL_FIELDS, "notification_settings", INPUT_ERROR_CODE);
  const action = requireAction(payload, "notification_settings", TOOL_ACTIONS, INPUT_ERROR_CODE);

  // MiniMax may materialize known set-only siblings for get. The read action ignores them and
  // cannot turn those values into a write; unpublished fields still fail in the global guard.
  if (action === "get") return { action } as const;
  return { action, values: requireSetInput(payload) } as const;
}

const TOOL_DESCRIPTION = [
  "Получить или настроить личный IANA timezone и тихие часы. В тихие часы не приходит ничего, что начато без просьбы человека: ни напоминание, ни сводка, ни предупреждение, ни предложение обновления. Отложенное уходит, когда тихие часы кончаются. Get: {\"action\":\"get\"}. Set: {\"action\":\"set\",\"timezone\":\"Europe/Moscow\",\"quietStart\":\"22:00\",\"quietEnd\":\"08:00\"}; quietStart и quietEnd разные значения ЧЧ:ММ, для отключения тихих часов оба null. Просьбу «не пиши мне первым» передавай как initiativeEnabled false, число сообщений в сутки как initiativeDailyLimit; непереданные поля остаются прежними. Не угадывай timezone и часы: если данных нет, спроси пользователя.",
].join(" ");

export default defineTool({
  approval: ({ toolInput }) => {
    const parsed = requireNotificationSettingsInput(toolInput);
    return parsed.action === "set" ? "user-approval" : "not-applicable";
  },
  description: TOOL_DESCRIPTION,
  inputSchema: notificationSettingsSchema,
  async execute(input, ctx) {
    const parsed = requireNotificationSettingsInput(input);
    const authorization = requireReminderAuthorization(ctx);
    if (authorization.telegramChatType !== "private") {
      throw new AppError(
        "AGENT_NOTIFICATION_SETTINGS_PRIVATE_ONLY",
        "Настройки уведомлений доступны только в личном чате",
      );
    }
    if (parsed.action === "get") {
      return await reminderRepository.getNotificationSettings(authorization);
    }

    return await reminderRepository.configureNotifications(authorization, parsed.values);
  },
});
