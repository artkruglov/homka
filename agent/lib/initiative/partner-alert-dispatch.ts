/**
 * Диспетчер уведомлений: тот же порядок проверок, что у коуча, другой источник содержания.
 *
 * Экспорт:
 * - `createPartnerAlertDispatcher`: диспетчер с подменяемыми зависимостями.
 *
 * Порядок: правило инициативы (выключатель, тихие часы, пауза после молчания, предел суток),
 * личное время, ожидающие пункты, заявка, отправка, запись в журнал доставок. Ждать нечего — нет
 * и сообщения. Первое уведомление уходит на ближайшем тике: предел «раз в сутки» ограничивает
 * следующие пакеты, а не первый. Неудачная доставка заявку не возвращает.
 */
import { MemoryReviewOwnerAlertTransportError } from "../memory-review/memory-review-owner-alert-transport.js";
import type { InitiativeDelivery } from "./initiative-delivery.js";
import { decideInitiative } from "./initiative-policy.js";
import { formatPartnerAlert, type PartnerAlertItem } from "./partner-alert.js";
import type { PartnerAlertRecipient } from "./partner-alert-repository.js";

export interface PartnerAlertDispatcherDependencies {
  recipients(): Promise<PartnerAlertRecipient[]>;
  pending(recipient: PartnerAlertRecipient, now: Date):
    Promise<{ items: PartnerAlertItem[]; pending: number }>;
  personalTime(recipient: PartnerAlertRecipient, now: Date): Promise<string | null>;
  claim(
    recipient: PartnerAlertRecipient,
    localDate: string,
    items: readonly PartnerAlertItem[],
    now: Date,
  ): Promise<string | null>;
  send(input: { chatId: string; text: string }): Promise<string>;
  record(delivery: InitiativeDelivery): Promise<void>;
}

function localDate(timezone: string, now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(now);
}

export function createPartnerAlertDispatcher(dependencies: PartnerAlertDispatcherDependencies) {
  return async function dispatchPartnerAlerts(now = new Date()): Promise<number> {
    let sent = 0;
    for (const recipient of await dependencies.recipients()) {
      if (!decideInitiative(recipient.settings, recipient.state, now).allowed) continue;
      const waiting = await dependencies.pending(recipient, now);
      const text = formatPartnerAlert(waiting.items, waiting.pending);
      if (text === null) continue;
      if (await dependencies.personalTime(recipient, now) !== null) continue;
      const deliveryRef = await dependencies.claim(
        recipient, localDate(recipient.settings.timezone, now), waiting.items, now,
      );
      if (deliveryRef === null) continue;
      let messageId: string;
      try {
        messageId = await dependencies.send({ chatId: recipient.telegramUserId, text });
      } catch (error) {
        console.error(JSON.stringify({
          code: error instanceof MemoryReviewOwnerAlertTransportError
            ? "AGENT_PARTNER_ALERT_FAILED"
            : "AGENT_PARTNER_ALERT_AMBIGUOUS",
          error: error instanceof Error ? error.message : String(error),
          familyId: recipient.familyId,
        }));
        continue;
      }
      sent += 1;
      console.info(JSON.stringify({
        code: "AGENT_PARTNER_ALERT_SENT",
        familyId: recipient.familyId,
        items: waiting.items.length,
      }));
      try {
        await dependencies.record({
          at: now, deliveryRef, familyId: recipient.familyId, messageId, sourceKind: "partner_alert",
          telegramUserId: recipient.telegramUserId, text, userId: recipient.userId,
        });
      } catch (error) {
        console.error(JSON.stringify({
          code: "AGENT_INITIATIVE_DELIVERY_RECORD_FAILED",
          error: error instanceof Error ? error.message : String(error),
          familyId: recipient.familyId,
          sourceKind: "partner_alert",
        }));
      }
    }
    return sent;
  };
}
