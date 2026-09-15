/**
 * Trusted current-time formatting.
 *
 * Exports:
 * - `CurrentTimeResult`: JSON-safe UTC and optional local civil-time snapshot.
 * - `formatCurrentTimeContext`: serializes the turn-start clock for inbound context.
 * - `resolveCurrentTime`: validates a timezone and formats one current-time snapshot.
 */
import { AppError } from "./app-error.js";

export interface CurrentTimeResult {
  capturedAtUtc: string;
  localDate: string | null;
  localTime: string | null;
  timezone: string | null;
  timezoneSource: "explicit" | "not_configured" | "user_settings";
  utcOffset: string | null;
  weekday: string | null;
}

const CURRENT_TIME_TIMEZONE_ERROR_CODE = "AGENT_CURRENT_TIME_TIMEZONE_INVALID";
const UTC_TIMEZONE = "UTC";
const VALID_TIMEZONES = new Set([UTC_TIMEZONE, ...Intl.supportedValuesOf("timeZone")]);
const LOCAL_TIME_FORMAT_OPTIONS = {
  calendar: "iso8601",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  month: "2-digit",
  numberingSystem: "latn",
  second: "2-digit",
  timeZoneName: "longOffset",
  weekday: "long",
  year: "numeric",
} as const;

function requireTimezone(timezone: string): string {
  if (!VALID_TIMEZONES.has(timezone)) {
    throw new AppError(
      CURRENT_TIME_TIMEZONE_ERROR_CODE,
      "Укажите корректный IANA timezone, например Europe/Moscow",
    );
  }
  return timezone;
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  const value = parts.find((candidate) => candidate.type === type)?.value;
  if (!value) {
    throw new AppError(
      "AGENT_CURRENT_TIME_FORMAT_FAILED",
      `Не удалось определить компонент локального времени: ${type}`,
    );
  }
  return value;
}

function utcOffset(parts: Intl.DateTimeFormatPart[]): string {
  const value = part(parts, "timeZoneName");
  if (value === "GMT") return "+00:00";
  if (/^GMT[+-]\d{2}:\d{2}$/u.test(value)) return value.slice(3);
  throw new AppError(
    "AGENT_CURRENT_TIME_FORMAT_FAILED",
    "Не удалось определить смещение локального времени относительно UTC",
  );
}

const LOCAL_TIME_UNAVAILABLE = "local: timezone не настроена, при необходимости уточни её";

function localTimeLine(currentTime: Date, timezone: string | null): string {
  if (timezone === null) return LOCAL_TIME_UNAVAILABLE;
  try {
    const local = resolveCurrentTime(currentTime, timezone, "user_settings");
    // Seconds add nothing to a conversational "сегодня вечером" and change on every turn.
    const minutes = local.localTime?.slice(0, 5);
    return `local: ${local.localDate} ${minutes} ${local.weekday}, ${local.timezone} (${local.utcOffset})`;
  } catch {
    // A stored timezone the runtime cannot format degrades to UTC instead of failing the turn.
    return LOCAL_TIME_UNAVAILABLE;
  }
}

/**
 * Local civil time lets the model answer "сегодня", "вечером" and weekday questions from context
 * instead of spending a tool call on every time-sensitive turn.
 */
export function formatCurrentTimeContext(currentTime: Date, timezone: string | null): string {
  return [
    "<current_time>",
    `captured_at_utc: ${currentTime.toISOString()}`,
    localTimeLine(currentTime, timezone),
    "precision: turn_start",
    "</current_time>",
  ].join("\n");
}

export function resolveCurrentTime(
  currentTime: Date,
  timezone: string | null,
  timezoneSource: CurrentTimeResult["timezoneSource"],
): CurrentTimeResult {
  // UTC remains useful without pretending that it is the user's local timezone.
  if (timezone === null) {
    return {
      capturedAtUtc: currentTime.toISOString(),
      localDate: null,
      localTime: null,
      timezone: null,
      timezoneSource,
      utcOffset: null,
      weekday: null,
    };
  }

  // Format all civil-time fields from one instant so date-boundary answers stay coherent.
  const validatedTimezone = requireTimezone(timezone);
  const parts = new Intl.DateTimeFormat("ru-RU", {
    ...LOCAL_TIME_FORMAT_OPTIONS,
    timeZone: validatedTimezone,
  }).formatToParts(currentTime);
  return {
    capturedAtUtc: currentTime.toISOString(),
    localDate: `${part(parts, "year")}-${part(parts, "month")}-${part(parts, "day")}`,
    localTime: `${part(parts, "hour")}:${part(parts, "minute")}:${part(parts, "second")}`,
    timezone: validatedTimezone,
    timezoneSource,
    utcOffset: utcOffset(parts),
    weekday: part(parts, "weekday"),
  };
}
