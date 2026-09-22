/**
 * Производственная сборка недельного обзора.
 *
 * Экспорт:
 * - `dispatchWeeklyReviews`: диспетчер с настоящими репозиторием и транспортом.
 */
import { memoryReviewOwnerAlertTransport } from "../memory-review/memory-review-owner-alert-transport.js";
import { personalTimeRepository } from "../personal-time/personal-time-repository.js";
import { recordInitiativeDelivery } from "./initiative-delivery.js";
import { createWeeklyReviewDispatcher } from "./weekly-review-dispatch.js";
import { weeklyReviewRepository } from "./weekly-review-repository.js";

export function dispatchWeeklyReviews(now = new Date()): Promise<number> {
  return createWeeklyReviewDispatcher({
    claim: (recipient, localDate, at) => weeklyReviewRepository.claim(recipient, localDate, at),
    personalTime: (recipient, at) => personalTimeRepository.conflictFor(recipient.telegramUserId, recipient.familyId, at),
    recipients: () => weeklyReviewRepository.recipients(now),
    record: recordInitiativeDelivery,
    review: (recipient, at) => weeklyReviewRepository.review(recipient, at),
    send: (input) => memoryReviewOwnerAlertTransport.send(input),
  })(now);
}
