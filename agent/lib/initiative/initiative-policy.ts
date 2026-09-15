/**
 * Разговор, начатый ботом: можно ли начать его прямо сейчас.
 *
 * Экспорт:
 * - `InitiativeKind`: вид начатого разговора; журнал держит только эти виды.
 * - `InitiativeSettings`, `InitiativeState`: настройки человека и то, что уже случилось за сутки.
 * - `InitiativeDecision`: решение с причиной, пригодной и для лога, и для ответа человеку.
 * - `decideInitiative`: само правило, без базы и без часов сервера.
 *
 * До сих пор ограничение жило фразой в промпте, то есть держалось на согласии модели. Здесь оно
 * становится данными: выключатель «не пиши мне первым», предел на сутки и пауза после молчания.
 *
 * Пауза после молчания — главное из трёх. Человек, который не ответил ни на одно предложение,
 * ответил именно этим; продолжать значит превращать помощь в рассылку. Пауза снимается его
 * собственным словом, а не временем: он пишет сам, и счёт неотвеченных обнуляется.
 *
 * Сводка здоровья и предупреждение о памяти сюда не входят: это служба отчитывается о себе, и
 * молчание вместо них читалось бы как «всё хорошо». Их держат только тихие часы.
 */
import { isWithinQuietHours, type QuietHours } from "./quiet-hours.js";

/** Сколько начатых подряд разговоров без единого ответа человека включают паузу. */
export const INITIATIVE_UNANSWERED_LIMIT = 3;

export type InitiativeKind = "suggestion" | "update_proposal" | "errand";

export interface InitiativeSettings extends QuietHours {
  /** «Не пиши мне первым»: выключатель человека, а не режим отладки. */
  readonly enabled: boolean;
  /** Сколько раз за сутки бот может начать разговор. Ноль это тот же выключатель. */
  readonly dailyLimit: number;
}

export interface InitiativeState {
  /** Начато сегодня по местной дате человека. */
  readonly sentToday: number;
  /** Начато подряд без ответа, считая от последнего его слова. */
  readonly unanswered: number;
}

export type InitiativeDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: "daily_limit" | "muted" | "quiet_hours" | "unanswered";
    };

export function decideInitiative(
  settings: InitiativeSettings,
  state: InitiativeState,
  now: Date,
): InitiativeDecision {
  if (!settings.enabled) return { allowed: false, reason: "muted" };
  if (isWithinQuietHours(settings, now)) return { allowed: false, reason: "quiet_hours" };
  if (state.unanswered >= INITIATIVE_UNANSWERED_LIMIT) {
    return { allowed: false, reason: "unanswered" };
  }
  if (state.sentToday >= settings.dailyLimit) return { allowed: false, reason: "daily_limit" };
  return { allowed: true };
}
