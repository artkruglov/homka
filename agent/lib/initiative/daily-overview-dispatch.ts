/**
 * Утренний обзор дня: единственное, что бот сегодня начинает сам.
 *
 * Экспорт:
 * - `DailyOverviewRecipient`: человек, его пояс и его правило инициативы.
 * - `createDailyOverviewDispatcher`: диспетчер с подменяемыми зависимостями.
 *
 * Порядок шагов выбран так, чтобы ни один из них нельзя было обойти: сначала утро в поясе
 * человека, потом общее правило инициативы (тихие часы, выключатель, предел суток, пауза после
 * молчания), потом содержание — и только потом заявка. Пустой обзор не занимает ни предел, ни
 * заявку: день, в котором нечего сказать, должен остаться днём без сообщения.
 *
 * Заявка пишется до отправки: два тика подряд не отправят два одинаковых обзора. Отказ Telegram
 * однозначен и заявку возвращает, любой другой сбой оставляет исход неизвестным — повтора нет.
 */
import { MemoryReviewOwnerAlertTransportError } from "../memory-review/memory-review-owner-alert-transport.js";
import { formatDailyOverview, type DailyOverview } from "./daily-overview.js";
import { decideInitiative, type InitiativeSettings, type InitiativeState } from "./initiative-policy.js";

/** Раньше этого часа по местному времени утренний обзор не отправляется. */
export const DAILY_OVERVIEW_LOCAL_HOUR = 8;

export interface DailyOverviewRecipient {
  readonly familyId: string;
  /** Обзор ещё ни разу не приходил: первое сообщение объясняет себя и называет выключатель. */
  readonly firstEver: boolean;
  readonly settings: InitiativeSettings;
  readonly state: InitiativeState;
  readonly telegramUserId: string;
  readonly userId: string;
}

export interface DailyOverviewDispatcherDependencies {
  /** Название окна личного времени, если оно идёт прямо сейчас. */
  personalTime(recipient: DailyOverviewRecipient, now: Date): Promise<string | null>;
  /** Заявка на сутки человека; `false` означает, что обзор сегодня уже отправляли. */
  claim(recipient: DailyOverviewRecipient, localDate: string): Promise<boolean>;
  deliver(input: { chatId: string; text: string }): Promise<void>;
  overview(recipient: DailyOverviewRecipient): Promise<DailyOverview>;
  recipients(): Promise<DailyOverviewRecipient[]>;
  release(recipient: DailyOverviewRecipient, localDate: string): Promise<void>;
}

function localParts(timezone: string, now: Date): { date: string; hour: number } {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(now);
  const hour = Number(new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit", hour12: false, timeZone: timezone,
  }).format(now)) % 24;
  return { date, hour };
}

export function createDailyOverviewDispatcher(
  dependencies: DailyOverviewDispatcherDependencies,
) {
  return async function dispatchDailyOverviews(now = new Date()): Promise<number> {
    let sent = 0;
    for (const recipient of await dependencies.recipients()) {
      const local = localParts(recipient.settings.timezone, now);
      if (local.hour < DAILY_OVERVIEW_LOCAL_HOUR) continue;
      const decision = decideInitiative(recipient.settings, recipient.state, now);
      if (!decision.allowed) continue;
      // Личное время принадлежит человеку: обзор подождёт следующего тика, как и тихие часы.
      if (await dependencies.personalTime(recipient, now) !== null) continue;
      // Содержание раньше заявки: день без дел остаётся днём без сообщения и не тратит предел.
      const text = formatDailyOverview(await dependencies.overview(recipient),
        { first: recipient.firstEver });
      if (text === null) continue;
      if (!await dependencies.claim(recipient, local.date)) continue;
      try {
        await dependencies.deliver({ chatId: recipient.telegramUserId, text });
        sent += 1;
      } catch (error) {
        const refused = error instanceof MemoryReviewOwnerAlertTransportError;
        if (refused) await dependencies.release(recipient, local.date);
        console.error(JSON.stringify({
          code: refused ? "AGENT_DAILY_OVERVIEW_FAILED" : "AGENT_DAILY_OVERVIEW_AMBIGUOUS",
          error: error instanceof Error ? error.message : String(error),
          familyId: recipient.familyId,
        }));
      }
    }
    return sent;
  };
}
