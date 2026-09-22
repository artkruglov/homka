/**
 * Производственная сборка уведомлений о том, что ждёт ответа.
 *
 * Экспорт:
 * - `dispatchPartnerAlerts`: диспетчер с настоящими репозиторием и транспортом.
 */
import { memoryReviewOwnerAlertTransport } from "../memory-review/memory-review-owner-alert-transport.js";
import { personalTimeRepository } from "../personal-time/personal-time-repository.js";
import { recordInitiativeDelivery } from "./initiative-delivery.js";
import { createPartnerAlertDispatcher } from "./partner-alert-dispatch.js";
import { partnerAlertRepository } from "./partner-alert-repository.js";

export function dispatchPartnerAlerts(now = new Date()): Promise<number> {
  return createPartnerAlertDispatcher({
    claim: (recipient, localDate, items, at) =>
      partnerAlertRepository.claim(recipient, localDate, items, at),
    pending: (recipient, at) => partnerAlertRepository.pending(recipient, at),
    personalTime: (recipient, at) =>
      personalTimeRepository.conflictFor(recipient.telegramUserId, recipient.familyId, at),
    recipients: () => partnerAlertRepository.recipients(now),
    record: recordInitiativeDelivery,
    send: (input) => memoryReviewOwnerAlertTransport.send(input),
  })(now);
}
