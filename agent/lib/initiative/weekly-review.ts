/**
 * Недельный обзор: раз в неделю показать то, что не попадает в утренний список.
 *
 * Экспорт:
 * - `WeeklyReviewInput`: дела человека и счётчик закрытого за неделю.
 * - `WEEKLY_REVIEW_QUESTIONS`: ровно три вопроса обзора.
 * - `formatWeeklyReview`: текст обзора либо `null`, когда пересматривать нечего.
 *
 * Истории T16 и B08, еженедельный пересмотр из GTD. Утренний обзор отвечает на «что сегодня», и
 * дело без срока в него не попадает никогда: оно живёт в списке месяцами, пока о нём не спросят.
 * Здесь собрано ровно то, что утро не показывает: просроченное, ожидание чужого ответа и дела без
 * следующего шага — без срока и без личного плана.
 *
 * Чего здесь нет и не должно появиться: советов, счёта вклада и серий («третья неделя подряд»).
 * Обзор задаёт три вопроса и предлагает действие, решение остаётся за человеком, а одна фраза его
 * выключает. Молчание это нормальный исход: неделя без просроченного, без ожидания и без
 * подвисших дел проходит без сообщения, и неделя одних идей тоже — идея ничего не обещает
 * (история B01), и напоминать о ней раз в неделю значит превращать её в долг.
 */
import {
  cleanTaskTitle, dueDay, isOverdue, localDate, OPEN_TASK_STATUSES, shortDate, type BoardTask,
} from "../task-board.js";

export interface WeeklyReviewInput {
  /** Открытые дела, идеи и традиции человека из всех его областей. */
  readonly tasks: readonly BoardTask[];
  /** Его просьбы другим, на которые ещё не ответили. */
  readonly waiting: readonly BoardTask[];
  /** Сколько дел закрыто за последние семь дней. */
  readonly closedLastWeek: number;
  readonly now: Date;
  /** Пояс человека: «просрочено» считается в его дне. */
  readonly timezone: string;
}

/** Три вопроса и не больше: длинная анкета остаётся без ответа целиком. */
export const WEEKLY_REVIEW_QUESTIONS = [
  "Что на этой неделе помогло?",
  "Что давит?",
  "Что можно убрать?",
] as const;

export const WEEKLY_REVIEW_OFFER = "Скажи, что закрыть, отложить, передать или снять — сделаю.";
export const WEEKLY_REVIEW_OPT_OUT = "«Хватит обзоров» — выключу.";
/** Столько строк на раздел: обзор для пересмотра, а не полный список, он уже есть по просьбе. */
const PER_SECTION = 5;

/** Дело без срока и без личного плана: записано и не начато, именно оно и теряется. */
function withoutNextStep(task: BoardTask, timezone: string): boolean {
  return task.kind === "task" && dueDay(task, timezone) === null
    && !task.plannedFrom && !task.plannedUntil;
}

export function formatWeeklyReview(input: WeeklyReviewInput): string | null {
  const today = localDate(input.timezone, input.now);
  const open = input.tasks.filter((task) => OPEN_TASK_STATUSES.has(task.status));
  const overdue = open.filter((task) => task.kind === "task" && isOverdue(task, input.now, today));
  const waiting = input.waiting.filter((task) => OPEN_TASK_STATUSES.has(task.status));
  const stalled = open.filter((task) => !overdue.includes(task) && withoutNextStep(task, input.timezone));
  const ideas = open.filter((task) => task.kind === "idea").length;

  // Пересматривать нечего: обзор ни о чём приучает не читать обзоры вовсе.
  if (overdue.length === 0 && waiting.length === 0 && stalled.length === 0) return null;

  const lines: string[] = ["Обзор недели."];
  if (input.closedLastWeek > 0) lines.push("", `За неделю закрыто: ${input.closedLastWeek}.`);

  const section = (title: string, tasks: readonly BoardTask[], suffix: (task: BoardTask) => string) => {
    if (tasks.length === 0) return;
    const shown = tasks.slice(0, PER_SECTION);
    const more = tasks.length - shown.length;
    lines.push("", `${title} · ${tasks.length}`,
      ...shown.map((task) => `• ${cleanTaskTitle(task.title, "plain")}${suffix(task)}`),
      ...(more > 0 ? [`…и ещё ${more}`] : []));
  };

  section("⚠️ Просрочено", overdue, (task) => ` — срок ${shortDate(dueDay(task, input.timezone)!)}`);
  section("Жду ответа", waiting, () => "");
  section("Без следующего шага", stalled, () => "");
  if (ideas > 0) lines.push("", `Идей на «когда-нибудь»: ${ideas}.`);

  return [...lines, "", ...WEEKLY_REVIEW_QUESTIONS, "", WEEKLY_REVIEW_OFFER, WEEKLY_REVIEW_OPT_OUT]
    .join("\n");
}
