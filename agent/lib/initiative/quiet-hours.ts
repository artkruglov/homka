/**
 * Тихие часы человека: одна проверка на всё, что бот начинает сам.
 *
 * Экспорт:
 * - `isWithinQuietHours`: проверка в процессе, когда настройки уже прочитаны.
 * - `quietHoursClause`: то же условие как фрагмент SQL для запроса, который сам выбирает адресатов.
 *
 * Тихие часы были только у напоминаний, и это выглядело как забота ровно до первой ночи, когда
 * сводка владельцу, предупреждение памяти или предложение обновления приходили в три часа. Человек
 * не делит сообщения по происхождению: будит его любое.
 *
 * Две формы нужны обе и обязаны совпадать. Запрос, который сам выбирает адресатов, не может
 * сначала выдать их все в процесс: выбрать спящего значит занять его строку арендой и не отправить.
 * А диспетчер, который уже держит адресата с его настройками, не должен ради этого ходить в базу.
 * Согласие форм проверяется на общей таблице случаев, а не на веру.
 *
 * Тихие часы **откладывают**, а не отменяют: сообщение уходит, когда они кончатся. Отмена нужна
 * там, где сообщение к утру устареет, и это решает вызывающий, а не эта проверка.
 */

export interface QuietHours {
  /** Конец тихих часов, `ЧЧ:ММ` местного времени. */
  readonly quietEnd: string | null;
  /** Начало тихих часов, `ЧЧ:ММ` местного времени. */
  readonly quietStart: string | null;
  /** IANA-пояс человека: границы заданы его часами, а не часами сервера. */
  readonly timezone: string;
}

function minutesOfDay(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function localMinutes(now: Date, timezone: string): number | null {
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit", hour12: false, minute: "2-digit", timeZone: timezone,
  }).formatToParts(now);
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  if (hour === undefined || minute === undefined) return null;
  // Полночь Intl в 24-часовом формате отдаёт как «24», а не «00».
  return (Number(hour) % 24) * 60 + Number(minute);
}

/** Ночное окно переходит через полночь, поэтому оно не сравнение, а объединение двух отрезков. */
export function isWithinQuietHours(settings: QuietHours, now: Date): boolean {
  if (settings.quietStart === null || settings.quietEnd === null) return false;
  const start = minutesOfDay(settings.quietStart);
  const end = minutesOfDay(settings.quietEnd);
  const current = localMinutes(now, settings.timezone);
  if (start === null || end === null || current === null || start === end) return false;
  return start < end
    ? current >= start && current < end
    : current >= start || current < end;
}

function positional(value: string): string {
  if (!/^\$\d{1,3}$/u.test(value)) {
    throw new Error("AGENT_QUIET_HOURS_PARAMETER_INVALID: ожидается позиционный параметр вида $1");
  }
  return value;
}

/**
 * Фрагмент «сейчас у этого человека тихие часы». Псевдоним указывает на строку
 * `user_notification_settings`, уже присоединённую вызывающим: соединение остаётся его делом,
 * потому что у одного запроса это автор напоминания, а у другого — владелец семьи.
 */
export function quietHoursClause(input: { alias: string; now: string }): string {
  if (!/^[a-z_][a-z_0-9]*$/u.test(input.alias)) {
    throw new Error("AGENT_QUIET_HOURS_ALIAS_INVALID: недопустимый псевдоним таблицы");
  }
  const settings = input.alias;
  const now = positional(input.now);
  const local = `(${now} AT TIME ZONE ${settings}.timezone)::time`;
  return `(${settings}.quiet_start IS NOT NULL AND ${settings}.quiet_end IS NOT NULL AND (
    (${settings}.quiet_start < ${settings}.quiet_end
      AND ${local} >= ${settings}.quiet_start AND ${local} < ${settings}.quiet_end) OR
    (${settings}.quiet_start > ${settings}.quiet_end
      AND (${local} >= ${settings}.quiet_start OR ${local} < ${settings}.quiet_end))
  ))`;
}
