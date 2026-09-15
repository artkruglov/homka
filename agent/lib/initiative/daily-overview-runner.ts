/**
 * Производственная сборка утреннего обзора.
 *
 * Экспорт:
 * - `dispatchDailyOverviews`: диспетчер с настоящими репозиторием и транспортом.
 *
 * Отдельный файл, потому что расписание Eve грузится при старте, а диспетчер и его зависимости
 * должны оставаться подменяемыми в тестах.
 */
import { createDailyOverviewDispatcher } from "./daily-overview-dispatch.js";
import { dailyOverviewRepository } from "./daily-overview-repository.js";
import { memoryReviewOwnerAlertTransport } from "../memory-review/memory-review-owner-alert-transport.js";
import { personalTimeRepository } from "../personal-time/personal-time-repository.js";

export function dispatchDailyOverviews(now = new Date()): Promise<number> {
  return createDailyOverviewDispatcher({
    claim: (recipient, localDate) => dailyOverviewRepository.claim(recipient, localDate),
    deliver: (input) => memoryReviewOwnerAlertTransport.deliver(input),
    overview: (recipient) => dailyOverviewRepository.overview(recipient),
    personalTime: (recipient, at) =>
      personalTimeRepository.conflictFor(recipient.telegramUserId, at),
    recipients: () => dailyOverviewRepository.recipients(now),
    release: (recipient, localDate) => dailyOverviewRepository.release(recipient, localDate),
  })(now);
}
