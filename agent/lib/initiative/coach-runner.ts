/**
 * Производственная сборка коуча.
 *
 * Экспорт:
 * - `dispatchCoachTouches`: диспетчер с настоящими репозиторием и транспортом.
 */
import { memoryReviewOwnerAlertTransport } from "../memory-review/memory-review-owner-alert-transport.js";
import { personalTimeRepository } from "../personal-time/personal-time-repository.js";
import { createCoachDispatcher } from "./coach-dispatch.js";
import { coachRepository } from "./coach-repository.js";
import { recordInitiativeDelivery } from "./initiative-delivery.js";

export function dispatchCoachTouches(now = new Date()): Promise<number> {
  return createCoachDispatcher({
    claim: (recipient, localDate, touch, at) => coachRepository.claim(recipient, localDate, touch, at),
    personalTime: (recipient, at) => personalTimeRepository.conflictFor(recipient.telegramUserId, at),
    recipients: () => coachRepository.recipients(now),
    record: recordInitiativeDelivery,
    release: (deliveryRef) => coachRepository.release(deliveryRef),
    send: (input) => memoryReviewOwnerAlertTransport.send(input),
  })(now);
}
