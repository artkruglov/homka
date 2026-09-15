/**
 * Личное время человека: окно, в которое оно принадлежит ему.
 *
 * Экспорт:
 * - `PersonalTimeWindow`: одно повторяющееся окно.
 * - `isWithinPersonalTime`: проверка в процессе, когда окна уже прочитаны.
 * - `personalTimeClause`: то же условие как фрагмент SQL для запроса, который выбирает людей сам.
 *
 * Окно значит две вещи, и обе проверяются кодом, а не вежливостью: бот не начинает в него
 * разговор, и чужое дело не ставится на это время. Своё дело человек ставит туда сам — это его
 * время, а не запрет на занятия.
 *
 * День недели берётся в поясе человека вместе с часами: «вторник с семи» в Москве и в Берлине это
 * разные моменты, и сравнивать их по UTC нельзя.
 */

export interface PersonalTimeWindow {
  /** Конец окна, `ЧЧ:ММ` местного времени. */
  readonly endsAt: string;
  /** Начало окна, `ЧЧ:ММ` местного времени. */
  readonly startsAt: string;
  readonly title: string;
  /** 0 — воскресенье; `null` означает каждый день. */
  readonly weekday: number | null;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function minutesOfDay(value: string): number | null {
  const match = /^(\d{2}):(\d{2})/u.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours > 23 || minutes > 59 ? null : hours * 60 + minutes;
}

function localMoment(at: Date, timezone: string): { minutes: number; weekday: number } | null {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit", hour12: false, minute: "2-digit", timeZone: timezone, weekday: "short",
  }).formatToParts(at);
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  const weekday = WEEKDAYS.indexOf(parts.find((part) => part.type === "weekday")?.value ?? "");
  if (hour === undefined || minute === undefined || weekday < 0) return null;
  return { minutes: (Number(hour) % 24) * 60 + Number(minute), weekday };
}

/** Название окна, в которое попадает момент, либо `null`. Название нужно, чтобы отказ был понятен. */
export function isWithinPersonalTime(
  windows: readonly PersonalTimeWindow[],
  at: Date,
  timezone: string,
): string | null {
  const moment = localMoment(at, timezone);
  if (moment === null) return null;
  for (const window of windows) {
    if (window.weekday !== null && window.weekday !== moment.weekday) continue;
    const start = minutesOfDay(window.startsAt);
    const end = minutesOfDay(window.endsAt);
    if (start === null || end === null || start >= end) continue;
    if (moment.minutes >= start && moment.minutes < end) return window.title;
  }
  return null;
}

function positional(value: string): string {
  if (!/^\$\d{1,3}$/u.test(value)) {
    throw new Error("AGENT_PERSONAL_TIME_PARAMETER_INVALID: ожидается позиционный параметр вида $1");
  }
  return value;
}

/**
 * Фрагмент «этот момент попадает в личное время этого человека». Псевдоним указывает на строку
 * `personal_time_windows`, уже присоединённую вызывающим; пояс передаётся выражением, потому что у
 * одного запроса это настройка адресата, а у другого — настройка исполнителя дела.
 */
export function personalTimeClause(input: {
  alias: string;
  at: string;
  /** Колонка пояса человека вида `settings.timezone`; отсутствующий пояс читается как UTC. */
  timezone: string;
}): string {
  if (!/^[a-z_][a-z_0-9]*$/u.test(input.alias)) {
    throw new Error("AGENT_PERSONAL_TIME_ALIAS_INVALID: недопустимый псевдоним таблицы");
  }
  const window = input.alias;
  const at = positional(input.at);
  if (!/^[a-z_][a-z_0-9]*(?:\.[a-z_][a-z_0-9]*)?$/u.test(input.timezone)) {
    throw new Error("AGENT_PERSONAL_TIME_TIMEZONE_INVALID: ожидается колонка пояса");
  }
  const local = `(${at} AT TIME ZONE COALESCE(${input.timezone},'UTC'))`;
  return `(${window}.weekday IS NULL OR ${window}.weekday = EXTRACT(DOW FROM ${local})::smallint)
    AND ${local}::time >= ${window}.starts_at AND ${local}::time < ${window}.ends_at`;
}
