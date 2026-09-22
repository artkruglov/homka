/**
 * Диспетчер недельного обзора: тот же порядок проверок, что у коуча, другой повод и другой текст.
 *
 * Экспорт:
 * - `createWeeklyReviewDispatcher`: диспетчер с подменяемыми зависимостями.
 *
 * Порядок: согласие человека, воскресный вечер его дня, общее правило инициативы (выключатель,
 * тихие часы, пауза после молчания, предел суток), личное время, содержание, заявка, отправка,
 * запись в журнал доставок. Пустой обзор заявку не тратит: неделя, в которой нечего пересматривать,
 * должна пройти молча и не закрыть путь настоящему обзору. Определённый отказ Telegram (бот
 * заблокирован) заявку не возвращает: иначе каждый десятиминутный тик вечера пробовал бы снова.
 * Неизвестный исход повтора тоже не получает. Сообщение, ушедшее без записи в журнал, остаётся
 * отправленным: сбой записи только логируется.
 */
import { MemoryReviewOwnerAlertTransportError } from "../memory-review/memory-review-owner-alert-transport.js";
import type { InitiativeDelivery } from "./initiative-delivery.js";
import { decideInitiative } from "./initiative-policy.js";
import { formatWeeklyReview, type WeeklyReviewInput } from "./weekly-review.js";
import type { WeeklyReviewRecipient } from "./weekly-review-repository.js";

/** Воскресный вечер: неделя уже прожита, а следующая ещё не началась. */
const WEEKLY_REVIEW_WEEKDAY = 0;
export const WEEKLY_REVIEW_FIRST_HOUR = 18;
export const WEEKLY_REVIEW_LAST_HOUR = 21;

export interface WeeklyReviewDispatcherDependencies {
  recipients(): Promise<WeeklyReviewRecipient[]>;
  personalTime(recipient: WeeklyReviewRecipient, now: Date): Promise<string | null>;
  review(recipient: WeeklyReviewRecipient, now: Date): Promise<WeeklyReviewInput>;
  claim(recipient: WeeklyReviewRecipient, localDate: string, now: Date): Promise<string | null>;
  send(input: { chatId: string; text: string }): Promise<string>;
  record(delivery: InitiativeDelivery): Promise<void>;
}

function localClock(timezone: string, now: Date): { date: string; hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit", hour: "2-digit", hour12: false, month: "2-digit",
    timeZone: timezone, weekday: "short", year: "numeric",
  }).formatToParts(now);
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    hour: Number(part("hour")) % 24,
    weekday: weekdays.indexOf(part("weekday")),
  };
}

export function createWeeklyReviewDispatcher(dependencies: WeeklyReviewDispatcherDependencies) {
  return async function dispatchWeeklyReview(now = new Date()): Promise<number> {
    let sent = 0;
    for (const recipient of await dependencies.recipients()) {
      // Выборка уже отсекает несогласных; проверка повторяется здесь, чтобы обзор не мог уйти
      // человеку, который его не просил, из-за ошибки в одном запросе.
      if (recipient.enabled !== true) continue;
      const clock = localClock(recipient.settings.timezone, now);
      if (clock.weekday !== WEEKLY_REVIEW_WEEKDAY) continue;
      if (clock.hour < WEEKLY_REVIEW_FIRST_HOUR || clock.hour >= WEEKLY_REVIEW_LAST_HOUR) continue;
      if (!decideInitiative(recipient.settings, recipient.state, now).allowed) continue;
      if (await dependencies.personalTime(recipient, now) !== null) continue;
      const text = formatWeeklyReview(await dependencies.review(recipient, now));
      if (text === null) continue;
      const deliveryRef = await dependencies.claim(recipient, clock.date, now);
      if (deliveryRef === null) continue;
      let messageId: string;
      try {
        messageId = await dependencies.send({ chatId: recipient.telegramUserId, text });
      } catch (error) {
        const refused = error instanceof MemoryReviewOwnerAlertTransportError;
        console.error(JSON.stringify({
          code: refused ? "AGENT_WEEKLY_REVIEW_FAILED" : "AGENT_WEEKLY_REVIEW_AMBIGUOUS",
          error: error instanceof Error ? error.message : String(error),
          familyId: recipient.familyId,
        }));
        continue;
      }
      sent += 1;
      console.info(JSON.stringify({ code: "AGENT_WEEKLY_REVIEW_SENT", familyId: recipient.familyId }));
      try {
        await dependencies.record({
          at: now, deliveryRef, familyId: recipient.familyId, messageId, sourceKind: "weekly_review",
          telegramUserId: recipient.telegramUserId, text, userId: recipient.userId,
        });
      } catch (error) {
        console.error(JSON.stringify({
          code: "AGENT_INITIATIVE_DELIVERY_RECORD_FAILED",
          error: error instanceof Error ? error.message : String(error),
          familyId: recipient.familyId,
          sourceKind: "weekly_review",
        }));
      }
    }
    return sent;
  };
}
