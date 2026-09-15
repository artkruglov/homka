/**
 * Обзор дня: что бот скажет человеку первым утром.
 *
 * Экспорт:
 * - `DailyOverview`: то, что у человека на сегодня, уже собранное по его личности.
 * - `formatDailyOverview`: текст обзора либо `null`, когда говорить не о чем.
 *
 * Обзор собирается детерминированно и форматируется здесь же, без модели. Так требует раздел 5
 * архитектуры: агент, одновременно видящий все области человека, для этого не запускается —
 * выборка идёт по личности, у каждой строки своя метка источника.
 *
 * Молчание это нормальный исход. Сообщение без содержания хуже, чем его отсутствие: человек
 * перестаёт читать утренние сообщения целиком, и следующее, в котором есть дело, тоже пропустит.
 */

export interface OverviewTask {
  /** Область или чат, из которого дело пришло: одинаковые названия в разных чатах это разные дела. */
  readonly source: string;
  readonly title: string;
}

export interface DailyOverview {
  /** Личные просьбы автора, на которые получатель ещё не ответил. */
  readonly waiting?: readonly OverviewTask[];
  /** Дела с сегодняшним сроком или личным планом на сегодня. */
  readonly today: readonly OverviewTask[];
  /** Дела, срок которых уже прошёл. */
  readonly overdue: readonly OverviewTask[];
  /** Чего от человека ждут другие: поручено ему и ещё не закрыто. */
  readonly promised: readonly OverviewTask[];
}

const MAX_LINES_PER_BLOCK = 5;

function block(title: string, tasks: readonly OverviewTask[]): string[] {
  if (tasks.length === 0) return [];
  const shown = tasks.slice(0, MAX_LINES_PER_BLOCK)
    .map((task) => `• ${task.title} — ${task.source}`);
  // Длинный список не перечисляется целиком: утреннее сообщение читают с телефона одним взглядом.
  const rest = tasks.length - shown.length;
  return [title, ...shown, ...(rest > 0 ? [`…и ещё ${rest}`] : [])];
}

/**
 * Первое такое сообщение объясняет себя само: откуда оно взялось и как его выключить. Человек не
 * обязан догадываться, почему бот заговорил первым, и не должен искать настройку, чтобы это
 * прекратить.
 */
const FIRST_TIME_EXPLANATION = [
  "Это утренний обзор: я показываю его раз в день, когда на день что-то есть.",
  "Скажите «не пиши мне первым» — перестану. Спросите «что ты умеешь здесь» — расскажу.",
].join(" ");

/** Возвращает `null`, когда говорить не о чем: пустой обзор не отправляется. */
export function formatDailyOverview(
  overview: DailyOverview,
  options: { first?: boolean } = {},
): string | null {
  const lines = [
    ...block("Просрочено:", overview.overdue),
    ...block("Сегодня:", overview.today),
    ...block("От вас ждут:", overview.promised),
    ...block("Жду ответа:", overview.waiting ?? []),
  ];
  if (lines.length === 0) return null;
  return [
    "Доброе утро. Вот что на сегодня.", "", ...lines,
    ...(options.first === true ? ["", FIRST_TIME_EXPLANATION] : []),
  ].join("\n");
}
