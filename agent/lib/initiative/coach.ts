/**
 * Коуч: один короткий вопрос не про дела, когда для него есть проверяемый повод.
 *
 * Экспорт:
 * - `CoachReason`: повод касания; журнал инициативы хранит его в `coach_reason`.
 * - `CoachFacts`: что известно о человеке из базы, без текста его переписки.
 * - `CoachTouch`: выбранное касание: повод, предмет и текст.
 * - `chooseCoachTouch`: правило выбора, без базы и без часов сервера.
 *
 * Документ о балансе семьи (`docs/family-balance-and-growth.ru.md`) описывает традиции, личное
 * время и тёплый недельный вопрос, но задуман пассивным: первый разговор оставлен людям, и за
 * месяц он не состоялся ни разу. Коуч это его проактивная половина с теми же запретами.
 * Расписания нет, есть потолок: касание только по поводу, не чаще раза в двое суток и трёх раз в
 * неделю. Коуч не говорит о делах и сроках, это работа утреннего обзора, иначе он стал бы вторым
 * напоминателем. Нагрузку не считает: число дел не мера вклада. Пропущенную традицию не ставит в
 * вину: вопрос предлагает отметить, пропустить или снять её.
 *
 * Включается только явным «да»: пока человек не ответил на приглашение, вопросов нет, молчание
 * это «не включено», а не пауза.
 */

export type CoachReason =
  | "invite"
  | "decision_open"
  | "ritual_checkin"
  | "week_warm"
  | "rest_window_missing"
  | "ritual_none";

export interface CoachFacts {
  /** `null`: приглашения ещё не было или на него не ответили; `false`: «без коуча». */
  readonly enabled: boolean | null;
  readonly invited: boolean;
  readonly lastTouchAt: Date | null;
  readonly touchesLastWeek: number;
  readonly lastByReason: Partial<Record<CoachReason, Date>>;
  /** Предложение партнёра, на которое человек ещё не ответил и о котором коуч не спрашивал. */
  readonly openDecision: { readonly id: string; readonly title: string; readonly proposer: string } | null;
  /** Традиция человека без отметок две недели, о которой коуч не спрашивал две недели. */
  readonly quietRitual: { readonly id: string; readonly title: string } | null;
  readonly personalWindows: number;
  readonly familyRituals: number;
}

export interface CoachClock {
  readonly hour: number;
  /** 0 воскресенье, как в `Date.getDay`. */
  readonly weekday: number;
}

export interface CoachTouch {
  readonly reason: CoachReason;
  readonly subject: string | null;
  readonly text: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Раньше и позже этих часов коуч не пишет: вопрос о себе не для утра перед работой и не для ночи. */
export const COACH_FIRST_HOUR = 10;
export const COACH_LAST_HOUR = 21;
export const COACH_MIN_GAP_MS = 2 * DAY_MS;
export const COACH_WEEKLY_LIMIT = 3;
/** Повтор одного и того же повода: личное время и традиции не чаще раза в две недели. */
const SLOW_REASON_GAP_MS = 14 * DAY_MS;
const WEEK_WARM_GAP_MS = 5 * DAY_MS;
const WEEK_WARM_FIRST_HOUR = 18;

export const COACH_INVITE_TEXT = [
  "Можно я иногда, не чаще пары раз в неделю, буду задавать один короткий вопрос не про дела?",
  "Про время для себя, про то, что порадовало или было тяжело, про ваши семейные традиции.",
  "Отвечать не обязательно. Скажи «да» — начну. «Без коуча» — не буду спрашивать,",
  "«не пиши мне первым» — замолчу совсем.",
].join(" ");

function quote(title: string): string {
  const clean = title.replace(/\s+/gu, " ").trim();
  return clean.length > 120 ? `${clean.slice(0, 119)}…` : clean;
}

function olderThan(at: Date | undefined, gap: number, now: Date): boolean {
  return at === undefined || now.getTime() - at.getTime() >= gap;
}

export function chooseCoachTouch(facts: CoachFacts, clock: CoachClock, now: Date): CoachTouch | null {
  if (facts.enabled === false) return null;
  if (clock.hour < COACH_FIRST_HOUR || clock.hour >= COACH_LAST_HOUR) return null;
  if (facts.enabled === null) {
    return facts.invited ? null : { reason: "invite", subject: null, text: COACH_INVITE_TEXT };
  }
  if (facts.lastTouchAt !== null && now.getTime() - facts.lastTouchAt.getTime() < COACH_MIN_GAP_MS) return null;
  if (facts.touchesLastWeek >= COACH_WEEKLY_LIMIT) return null;

  if (facts.openDecision) {
    const { id, proposer, title } = facts.openDecision;
    return {
      reason: "decision_open", subject: id,
      text: `${proposer} предлагает: «${quote(title)}». Ты за, против или хочется обсудить? `
        + "Решаешь только ты, молчание я согласием не считаю.",
    };
  }
  if (facts.quietRitual) {
    const { id, title } = facts.quietRitual;
    return {
      reason: "ritual_checkin", subject: id,
      text: `Как «${quote(title)}» — получалось в последнее время? `
        + "Можно отметить, пропустить или снять традицию, ничего не горит.",
    };
  }
  const weekEnd = clock.weekday === 5 || clock.weekday === 0;
  if (weekEnd && clock.hour >= WEEK_WARM_FIRST_HOUR && olderThan(facts.lastByReason.week_warm, WEEK_WARM_GAP_MS, now)) {
    return {
      reason: "week_warm", subject: null,
      text: "Что на этой неделе порадовало? И если хочется, одно, что было тяжело.",
    };
  }
  if (facts.personalWindows === 0 && olderThan(facts.lastByReason.rest_window_missing, SLOW_REASON_GAP_MS, now)) {
    return {
      reason: "rest_window_missing", subject: null,
      text: "Есть в неделе час, который только твой? Назови день и время — поставлю окно "
        + "личного времени, и в него я писать не буду.",
    };
  }
  if (facts.familyRituals === 0 && olderThan(facts.lastByReason.ritual_none, SLOW_REASON_GAP_MS, now)) {
    return {
      reason: "ritual_none", subject: null,
      text: "Есть что-то маленькое, что хочется делать вместе регулярно: чай без телефонов, "
        + "прогулка, семейный ужин? Запишу как традицию, без обязательств и отчётов.",
    };
  }
  return null;
}
