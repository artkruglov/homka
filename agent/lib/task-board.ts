/**
 * Доска дел: весь открытый список перед глазами, оформленный кодом, а не моделью.
 *
 * Exports:
 * - `BoardTask`: поля строки списка, которых хватает для доски.
 * - `formatTaskBoard`: текст доски или `null`, когда показывать нечего.
 * - `taskBoardReply`: та же доска для ответа модели, защищённая от автоката.
 * - `OPEN_TASK_STATUSES`, `isOverdue`, `dueDay`, `shortDate`, `localDate`, `cleanTaskTitle`: разбор строки для
 *   другого детерминированного текста о тех же делах (недельный обзор), чтобы даты и обрезка
 *   названий считались здесь один раз, а не повторялись рядом.
 *
 * Раньше утренний обзор показывал только дела со сроком на сегодня, а «покажи дела» модель
 * пересказывала сплошным абзацем через запятую, и автокат прятал середину под «Полный ответ».
 * Здесь порядок один и тот же: просроченное, сегодня, затем все открытые дела по спискам,
 * идеи отдельно как «Когда-нибудь», просьбы другим отдельно. Одно дело на строку.
 */
import { TELEGRAM_KEEP_OPEN_DIRECTIVE } from "./telegram-final-presentation.js";

export interface BoardTask {
  readonly title: string;
  readonly status: string;
  readonly kind: string;
  readonly listName: string | null;
  readonly source: string;
  readonly dueOn: string | null;
  readonly dueAt: string | null;
  readonly plannedFrom?: string | null;
  readonly plannedUntil?: string | null;
}

export interface TaskBoardInput {
  /** Открытые дела, идеи и традиции человека. */
  readonly tasks: readonly BoardTask[];
  /** Его просьбы другим, на которые ещё не ответили. */
  readonly waiting?: readonly BoardTask[];
  readonly now: Date;
  readonly timezone: string;
  /** plain для служебных сообщений без разметки, rich для ответа модели. */
  readonly style: "plain" | "rich";
  readonly perGroup?: number;
}

export const OPEN_TASK_STATUSES: ReadonlySet<string> = new Set(["open", "proposed", "accepted"]);
/** Потолок доски: утренний обзор уходит одним сообщением, предел Telegram 4096 знаков. */
export const TASK_BOARD_MAX_CHARACTERS = 3500;
const TASK_BOARD_MAX_TITLE = 120;
const NO_LIST = "Без списка";
const PERSONAL_SOURCE = "Личное";

export function localDate(timezone: string, at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(at);
}

export function shortDate(isoDate: string): string {
  const [, month, day] = isoDate.split("-");
  return `${day}.${month}`;
}

export function dueDay(task: BoardTask, timezone: string): string | null {
  if (task.dueOn) return task.dueOn;
  return task.dueAt ? localDate(timezone, new Date(task.dueAt)) : null;
}

export function isOverdue(task: BoardTask, now: Date, today: string): boolean {
  // Срок-время прошёл по часам, срок-дата прошёл, когда наступил следующий день.
  if (task.dueAt) return new Date(task.dueAt).getTime() < now.getTime();
  return task.dueOn !== null && task.dueOn < today;
}

function isToday(task: BoardTask, today: string, timezone: string): boolean {
  if (dueDay(task, timezone) === today) return true;
  return Boolean(task.plannedFrom && task.plannedUntil && task.plannedFrom <= today && task.plannedUntil >= today);
}

/**
 * Название дела пишет человек, а доска попадает в чужой чат: ссылка, код или `**` из названия
 * иначе становятся разметкой в доске другого участника. В rich-стиле разметка гасится обратной
 * косой чертой, длинное название обрезается, чтобы одна запись не съела весь бюджет сообщения.
 */
export function cleanTaskTitle(title: string, style: TaskBoardInput["style"]): string {
  const flat = title.replace(/\s+/gu, " ").trim();
  const short = flat.length > TASK_BOARD_MAX_TITLE ? `${flat.slice(0, TASK_BOARD_MAX_TITLE - 1)}…` : flat;
  return style === "rich" ? short.replace(/[\\*_`~|[\]()<>=]/gu, "\\$&") : short;
}

function note(task: BoardTask): string {
  if (task.status === "open") return " · свободное";
  if (task.status === "proposed") return " · ждёт согласия";
  return "";
}

export function formatTaskBoard(input: TaskBoardInput): string | null {
  const perGroup = input.perGroup ?? 5;
  const today = localDate(input.timezone, input.now);
  const heading = (text: string) => input.style === "rich" ? `**${text}**` : text;
  const item = (task: BoardTask, suffix = "") => `• ${cleanTaskTitle(task.title, input.style)}${suffix}${note(task)}`;

  const open = input.tasks.filter((task) => OPEN_TASK_STATUSES.has(task.status));
  const commitments = open.filter((task) => task.kind === "task");
  const overdue = commitments.filter((task) => isOverdue(task, input.now, today));
  const todays = commitments.filter((task) => !overdue.includes(task) && isToday(task, today, input.timezone));
  const rest = commitments.filter((task) => !overdue.includes(task) && !todays.includes(task));
  const ideas = open.filter((task) => task.kind === "idea");
  const rituals = open.filter((task) => task.kind === "ritual");
  const waiting = (input.waiting ?? []).filter((task) => OPEN_TASK_STATUSES.has(task.status));

  const sections: string[][] = [];
  const section = (title: string, tasks: readonly BoardTask[], line: (task: BoardTask) => string) => {
    if (tasks.length === 0) return;
    const shown = tasks.slice(0, perGroup).map(line);
    const more = tasks.length - shown.length;
    sections.push([heading(`${title} · ${tasks.length}`), ...shown, ...(more > 0 ? [`…и ещё ${more}`] : [])]);
  };

  section("⚠️ Просрочено", overdue, (task) => item(task, ` — срок ${shortDate(dueDay(task, input.timezone)!)}`));
  section("Сегодня", todays, (task) => item(task));
  // Список это группа дел по смыслу; одинаковое имя в разных областях это разные списки.
  const groups = new Map<string, BoardTask[]>();
  for (const task of rest) {
    const name = task.listName ?? NO_LIST;
    const key = task.source === PERSONAL_SOURCE ? name : `${name} (${task.source})`;
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) =>
    (a === NO_LIST ? 1 : 0) - (b === NO_LIST ? 1 : 0) || a.localeCompare(b, "ru"));
  for (const [name, tasks] of ordered) {
    section(name, tasks, (task) => {
      const day = dueDay(task, input.timezone);
      return item(task, day ? ` — до ${shortDate(day)}` : "");
    });
  }
  section("Жду ответа", waiting, (task) => item(task));
  section("Когда-нибудь", ideas, (task) => item(task));
  section("Традиции", rituals, (task) => item(task));

  if (sections.length === 0) return null;
  const footer = `Открытых дел: ${commitments.length}`;
  // Утренний обзор уходит одним сообщением Telegram: доска, не влезшая в предел, не доходит вовсе.
  // Поэтому лишние разделы отбрасываются с честным хвостом, а не рвутся посередине.
  const blocks = sections.map((lines) => lines.join("\n"));
  const kept: string[] = [];
  // Запас под хвост «…и ещё N разделов» и пустые строки между блоками.
  let length = footer.length + 60;
  for (const block of blocks) {
    if (length + block.length + 2 > TASK_BOARD_MAX_CHARACTERS && kept.length > 0) break;
    kept.push(block);
    length += block.length + 2;
  }
  const dropped = blocks.length - kept.length;
  return [
    ...kept,
    ...(dropped > 0 ? [`…и ещё ${dropped} ${dropped === 1 ? "раздел" : "раздела"}, спроси о них отдельно`] : []),
    footer,
  ].join("\n\n");
}

/**
 * Доска для ответа в чате: с жирными заголовками и директивой, которая не даёт автокату свернуть
 * её в «Полный ответ». Модель пересылает это поле как есть.
 */
export function taskBoardReply(tasks: readonly BoardTask[], now: Date, timezone: string): string | null {
  const board = formatTaskBoard({ now, style: "rich", tasks, timezone });
  return board === null ? null : `${TELEGRAM_KEEP_OPEN_DIRECTIVE}\n${board}`;
}
