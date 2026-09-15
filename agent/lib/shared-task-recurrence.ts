/**
 * Повторяющееся дело: правило и отдельные вхождения.
 *
 * Экспорт:
 * - `TaskRecurrence`: правило повтора, как его задаёт человек.
 * - `nextOccurrenceOn`: дата следующего вхождения, без проигрывания пропущенных.
 * - `advanceRecurringTask`: закрытие текущего вхождения и переход к следующему.
 *
 * Закрытие текущего вхождения не закрывает будущее: дело не уходит в `completed`, а получает
 * следующую дату. Само выполнение записывается отдельной строкой — по ней видно, кто и когда
 * закрыл именно это вхождение.
 *
 * Пропуски не проигрываются: если дело не закрывали месяц, следующей становится ближайшая будущая
 * дата, а не лавина прошедших. «Через месяц после выполнения» считается от факта, а не от
 * календаря, поэтому у него своя ветка.
 */
import type { PoolClient } from "pg";

import { AppError } from "./app-error.js";
import { localDate, type TaskRow } from "./shared-task-access.js";

export interface TaskRecurrence {
  readonly interval: number;
  readonly unit: "daily" | "weekly" | "monthly" | "after_completion";
}

const STEP: Readonly<Record<string, "day" | "week" | "month">> = {
  after_completion: "day", daily: "day", monthly: "month", weekly: "week",
};

function addTo(date: string, unit: "day" | "week" | "month", amount: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  if (unit !== "month") {
    value.setUTCDate(value.getUTCDate() + amount * (unit === "week" ? 7 : 1));
    return value.toISOString().slice(0, 10);
  }
  // «Каждое 31-е» в феврале это 28-е, а не 3 марта: короткий месяц обрезает день, а не
  // переносит дело в следующий. Прибавление месяцев в JS само перекатывается через край.
  const day = value.getUTCDate();
  const shifted = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + amount, 1));
  const lastDay = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0))
    .getUTCDate();
  shifted.setUTCDate(Math.min(day, lastDay));
  return shifted.toISOString().slice(0, 10);
}

/** Сколько вхождений правила уже прошло к этому дню. Оценка снизу: уточняет её перебор. */
function elapsedOccurrences(
  anchorOn: string, today: string, step: "day" | "week" | "month", interval: number,
): number {
  const anchor = new Date(`${anchorOn}T00:00:00Z`);
  const now = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(anchor.getTime()) || Number.isNaN(now.getTime()) || now <= anchor) return 0;
  const months = (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12
    + (now.getUTCMonth() - anchor.getUTCMonth());
  const days = Math.floor((now.getTime() - anchor.getTime()) / 86_400_000);
  const passed = step === "month" ? months : Math.floor(days / (step === "week" ? 7 : 1));
  return Math.max(0, Math.floor(passed / interval) - 1);
}

/**
 * Календарное правило отсчитывается от исходного якоря, а не от прошлой даты: иначе один
 * пропущенный месяц сдвигал бы все будущие пятницы.
 */
export function nextOccurrenceOn(input: {
  anchorOn: string;
  interval: number;
  occurrenceIndex: number;
  today: string;
  unit: TaskRecurrence["unit"];
}): { occurrenceIndex: number; on: string } {
  if (input.unit === "after_completion") {
    return {
      occurrenceIndex: input.occurrenceIndex + 1,
      on: addTo(input.today, "day", input.interval),
    };
  }
  const step = STEP[input.unit]!;
  // Шаги не перебираются от первого: у ежедневного правила тысяча шагов это меньше трёх лет, и
  // человек, вернувшийся к заброшенному делу, не смог бы его закрыть вовсе. Сначала грубая
  // оценка прошедшего, потом обычный перебор — он и уточняет короткий месяц.
  const start = Math.max(input.occurrenceIndex, elapsedOccurrences(input.anchorOn, input.today, step, input.interval)) + 1;
  for (let index = start; index <= start + 1_000; index += 1) {
    const on = addTo(input.anchorOn, step, input.interval * index);
    if (on > input.today) return { occurrenceIndex: index, on };
  }
  throw new AppError(
    "AGENT_TASK_RECURRENCE_EXHAUSTED",
    "Не удалось вычислить следующее повторение этого дела",
  );
}

/** Возвращает дату следующего вхождения либо `null`, если дело не повторяется. */
export async function advanceRecurringTask(
  client: PoolClient,
  task: TaskRow & {
    occurrence_index: number;
    recurrence_anchor_on: string | null;
    recurrence_interval: number | null;
    recurrence_unit: TaskRecurrence["unit"] | null;
  },
  input: { actorTelegramId: string; timezone: string },
): Promise<string | null> {
  if (task.recurrence_unit === null || task.recurrence_interval === null) return null;
  const today = localDate(input.timezone);
  const next = nextOccurrenceOn({
    anchorOn: task.recurrence_anchor_on ?? today,
    interval: task.recurrence_interval,
    occurrenceIndex: task.occurrence_index,
    today,
    unit: task.recurrence_unit,
  });
  // Выполнение конкретного вхождения записывается отдельно: по нему видно, кто и когда закрыл.
  const marked = await client.query(
    `INSERT INTO shared_ritual_occurrences(task_id,actor_telegram_id,occurred_on,note)
     VALUES($1,$2,$3::date,$4) ON CONFLICT(task_id,actor_telegram_id,occurred_on) DO NOTHING`,
    [task.id, input.actorTelegramId, today, `Выполнено: ${task.title}`.slice(0, 1000)],
  );
  // Второе «сделал» в тот же день закрывать нечего: отметка уже стоит. Сдвинуть срок ещё раз
  // значило бы съесть завтрашнее вхождение, не оставив следа нигде.
  if (marked.rowCount === 0) return task.due_on;
  // Личный план относился к закрытому вхождению: держать его на следующем значит обещать за человека.
  await client.query("DELETE FROM shared_task_plans WHERE task_id=$1", [task.id]);
  await client.query(
    `UPDATE shared_tasks SET due_on=$2::date, occurrence_index=$3, version=version+1, updated_at=now()
      WHERE id=$1`,
    [task.id, next.on, next.occurrenceIndex],
  );
  return next.on;
}
