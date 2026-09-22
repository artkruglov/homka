/**
 * Daily health digest for the family owner.
 *
 * Exports:
 * - `formatOwnerHealthDigest`: one plain-text Telegram message from the report.
 * - `createOwnerHealthDigestDispatcher` / `dispatchOwnerHealthDigests`: send once per day per owner.
 *
 * Key constructs:
 * - Three incidents in one week were found by people, not by the agent: a member's private chat
 *   silent for a night, a group session poisoned for two hours, a review lane stuck for three days
 *   with 1 400 unreviewed messages. The signals existed in tables; nobody read them. The digest
 *   reads them every morning and says so even when everything is fine, so silence means the
 *   dispatcher itself is down.
 * - The schedule ticks every ten minutes; the dispatcher sends after the digest hour and takes a
 *   durable claim first, so a restart neither skips a day nor sends it twice.
 */
import { DEEPSEEK_BALANCE_ALERT_USD } from "../../config.js";
import { isWithinQuietHours } from "../initiative/quiet-hours.js";
import { readConfiguredDeepSeekBalance } from "./deepseek-balance.js";
import { type DeepSeekBalance, formatDeepSeekBalance, formatModelSpend } from "./model-spend.js";
import { formatStorageHeadroom } from "./storage-headroom.js";
import {
  MemoryReviewOwnerAlertTransportError,
  memoryReviewOwnerAlertTransport,
} from "../memory-review/memory-review-owner-alert-transport.js";
import {
  type OwnerHealthRecipient,
  type OwnerHealthReport,
  ownerHealthDigestRepository,
} from "./owner-health-digest-repository.js";

export const OWNER_HEALTH_DIGEST_HOUR_UTC = 6;
export const OWNER_HEALTH_DIGEST_WINDOW_MILLISECONDS = 24 * 60 * 60 * 1_000;

const MOSCOW = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric", hour: "2-digit", minute: "2-digit", month: "long", timeZone: "Europe/Moscow",
});

function when(date: Date): string {
  return MOSCOW.format(date);
}

export function formatOwnerHealthDigest(report: OwnerHealthReport, balance: DeepSeekBalance | null = null): string {
  const lines: string[] = [];
  // Кончившийся баланс DeepSeek значит, что бот не отвечает: это сбой, а не справка.
  const balanceLine = formatDeepSeekBalance(balance, DEEPSEEK_BALANCE_ALERT_USD);
  if (balanceLine?.warning) lines.push(balanceLine.text);
  if (report.rotations.count > 0) {
    lines.push(`Сессии: ${report.rotations.count} ротаций после сбоя` +
      (report.rotations.latestAt ? `, последняя ${when(report.rotations.latestAt)}` : "") + ".");
  }
  if (report.ingressFailures.count > 0) {
    const codes = report.ingressFailures.codes.map((entry) => `${entry.code} ×${entry.count}`).join(", ");
    lines.push(`Очередь Telegram: ${report.ingressFailures.count} сбоев (${codes}).`);
  }
  // Ни одна строка не называет чат, человека или текст: дайджест читает владелец в своей личной
  // области, а стоящий лейн может принадлежать соседней. Счётчика и кода хватает, чтобы пойти
  // смотреть; названия хватило бы, чтобы узнать чужое.
  if (report.lanes.blocked.count > 0) {
    const codes = report.lanes.blocked.codes.map((entry) => `${entry.code} ×${entry.count}`).join(", ");
    lines.push(`Проверка памяти: ${report.lanes.blocked.count} лейнов стоят (${codes}),` +
      ` ждут ${report.lanes.blocked.waiting} сообщений.`);
  }
  if (report.lanes.lagging.count > 0) {
    lines.push(`Проверка памяти: ${report.lanes.lagging.count} лейнов отстают,` +
      ` ждут ${report.lanes.lagging.waiting} сообщений` +
      (report.lanes.lagging.oldestAt ? ` с ${when(report.lanes.lagging.oldestAt)}` : "") + ".");
  }
  if (report.reviewBatches.failed > 0 || report.reviewBatches.ambiguous > 0) {
    lines.push(`Пакеты проверки: failed ${report.reviewBatches.failed}, ambiguous ${report.reviewBatches.ambiguous}.`);
  }
  if (report.alertDeliveryFailures > 0) {
    lines.push(`Не доставлено предупреждений владельцу: ${report.alertDeliveryFailures}.`);
  }
  if (report.proactiveFailures.reminders > 0 || report.proactiveFailures.schedules > 0) {
    lines.push(`Требуют проверки: напоминания — ${report.proactiveFailures.reminders}, расписания — ${report.proactiveFailures.schedules}.`);
    lines.push("Это текущие неустранённые сбои, включая прежние дни. Перед возобновлением проверьте, не пришло ли сообщение: при сбое связи результат доставки может быть неизвестен.");
  }
  // Место на диске это не сбой за сутки, а условие, при котором откат вообще возможен.
  const storage = formatStorageHeadroom(report.storage);
  if (storage !== null) lines.push(storage);
  const written = report.memoryWritten.reduce((sum, entry) => sum + entry.count, 0);
  const breakdown = report.memoryWritten.map((entry) => `${entry.scope} ${entry.kind} ${entry.count}`).join(", ");
  const memory = written === 0 ? "Память: новых записей нет." : `Память: +${written} (${breakdown}).`;
  const header = lines.length === 0 ? "Сводка за сутки: сбоев нет." : "Сводка за сутки.";
  // Раз в неделю видно, вышло ли что-то из практик: иначе о пользе снова судят по ощущениям.
  const weekly = report.practices === null ? [] : [
    `За неделю: касаний коуча ${report.practices.sent.coach} (ответов ${report.practices.answered.coach}),` +
    ` уведомлений ${report.practices.sent.partnerAlert} (ответов ${report.practices.answered.partnerAlert}),` +
    ` обзоров ${report.practices.sent.weeklyReview} (ответов ${report.practices.answered.weeklyReview}).`,
    `Появилось за неделю: традиций ${report.practices.newRituals}, идей ${report.practices.newIdeas},` +
    ` областей заботы ${report.practices.newCareAreas}; закрыто дел ${report.practices.closedTasks}.`,
  ];
  // Расход и здоровый баланс это справка: они не превращают тихий день в день со сбоями.
  const spend = formatModelSpend(report.modelSpend);
  const information = [
    ...(spend === null ? [] : [spend]),
    ...(balanceLine !== null && !balanceLine.warning ? [balanceLine.text] : []),
  ];
  return [header, ...lines, ...information, memory, ...weekly].join("\n");
}

interface OwnerHealthDigestDependencies {
  /** Неясный исход: заявка остаётся навсегда с кодом, повтор запрещён. */
  abandon(familyId: string, digestDate: string, diagnosticCode: string): Promise<void>;
  /** Баланс счёта модели, если установка ходит в DeepSeek; читается один раз за проход. */
  balance(): Promise<DeepSeekBalance | null>;
  claim(familyId: string, digestDate: string, now: Date): Promise<boolean>;
  complete(familyId: string, digestDate: string, now: Date, textLength: number): Promise<void>;
  deliver(input: { chatId: string; text: string }): Promise<void>;
  recipients(): Promise<OwnerHealthRecipient[]>;
  release(familyId: string, digestDate: string): Promise<void>;
  report(familyId: string, windowStart: Date, now: Date): Promise<OwnerHealthReport>;
}

/** The digest day is the UTC date once the digest hour has passed; before it there is nothing to send. */
export function digestDateFor(now: Date): string | null {
  if (now.getUTCHours() < OWNER_HEALTH_DIGEST_HOUR_UTC) return null;
  return now.toISOString().slice(0, 10);
}

export function createOwnerHealthDigestDispatcher(dependencies: OwnerHealthDigestDependencies) {
  return async function dispatchOwnerHealthDigests(now = new Date()): Promise<number> {
    const digestDate = digestDateFor(now);
    if (digestDate === null) return 0;
    let sent = 0;
    let balance: Promise<DeepSeekBalance | null> | undefined;
    for (const recipient of await dependencies.recipients()) {
      // Заявка не берётся вовсе: взятая и неотправленная, она стоила бы владельцу дайджеста за
      // сутки, а тихие часы кончаются в тех же сутках, и следующий тик отправит его сам.
      if (isWithinQuietHours(recipient, now)) continue;
      if (!await dependencies.claim(recipient.familyId, digestDate, now)) continue;
      try {
        const report = await dependencies.report(
          recipient.familyId,
          new Date(now.getTime() - OWNER_HEALTH_DIGEST_WINDOW_MILLISECONDS),
          now,
        );
        balance ??= dependencies.balance();
        const text = formatOwnerHealthDigest(report, await balance);
        await dependencies.deliver({ chatId: recipient.ownerTelegramUserId, text });
        await dependencies.complete(recipient.familyId, digestDate, now, text.length);
        console.info(JSON.stringify({
          code: "AGENT_OWNER_HEALTH_DIGEST_SENT",
          blockedLanes: report.lanes.blocked.count,
          familyId: recipient.familyId,
          ingressFailures: report.ingressFailures.count,
          rotations: report.rotations.count,
        }));
        sent += 1;
      } catch (error) {
        // Отказ Telegram однозначен: сообщение не ушло, и заявку можно вернуть — потерянный
        // дайджест это ровно то молчание, ради которого он и существует. Любой другой сбой
        // оставляет исход неизвестным: Telegram мог сообщение принять, поэтому повтора нет.
        const refused = error instanceof MemoryReviewOwnerAlertTransportError;
        if (refused) await dependencies.release(recipient.familyId, digestDate);
        else await dependencies.abandon(recipient.familyId, digestDate, "AGENT_OWNER_HEALTH_DIGEST_AMBIGUOUS");
        console.error(JSON.stringify({
          code: refused ? "AGENT_OWNER_HEALTH_DIGEST_FAILED" : "AGENT_OWNER_HEALTH_DIGEST_AMBIGUOUS",
          error: error instanceof Error ? error.message : String(error),
          familyId: recipient.familyId,
        }));
      }
    }
    return sent;
  };
}

export function dispatchOwnerHealthDigests(now = new Date()): Promise<number> {
  return createOwnerHealthDigestDispatcher({
    abandon: (familyId, digestDate, code) => ownerHealthDigestRepository.abandon(familyId, digestDate, code),
    balance: readConfiguredDeepSeekBalance,
    claim: (familyId, digestDate, at) => ownerHealthDigestRepository.claim(familyId, digestDate, at),
    complete: (familyId, digestDate, at, length) => ownerHealthDigestRepository.complete(familyId, digestDate, at, length),
    deliver: (input) => memoryReviewOwnerAlertTransport.deliver(input),
    recipients: () => ownerHealthDigestRepository.recipients(),
    release: (familyId, digestDate) => ownerHealthDigestRepository.release(familyId, digestDate),
    report: (familyId, windowStart, at) => ownerHealthDigestRepository.report(familyId, windowStart, at),
  })(now);
}
