/**
 * Reminder dispatch orchestration.
 *
 * Exports:
 * - `createReminderDispatcher`: injectable deterministic lease-to-delivery processor.
 * - `dispatchDueReminders`: production dispatcher used by the Eve minute schedule.
 */
import { isAppError } from "../app-error.js";
import { isTransientDatabaseConnectionError, recoverDatabaseBookkeeping } from "../database-recovery.js";
import type { ProactiveDeliveryReceipt } from "../proactive-deliveries/proactive-delivery-repository.js";
import {
  REMINDER_DISPATCH_BATCH_SIZE,
  REMINDER_DISPATCH_LEASE_MILLISECONDS,
} from "./reminder-config.js";
import {
  type ClaimedReminder,
  reminderDispatchRepository,
} from "./reminder-dispatch-repository.js";
import { deliverTelegramReminder } from "./telegram-reminder-delivery.js";
import {
  telegramGroupJournalRepository,
  type TelegramGroupJournalRepository,
} from "../telegram-group-journal-repository.js";

interface ReminderDispatcherRepository {
  claimDue(options: {
    leaseMilliseconds: number;
    limit: number;
    now: Date;
  }): Promise<ClaimedReminder[]>;
  complete(
    job: ClaimedReminder,
    completedAt: Date,
    receipt: ProactiveDeliveryReceipt,
  ): Promise<void>;
  fail(job: ClaimedReminder, errorCode: string): Promise<void>;
  markDispatchStarted(id: string, leaseToken: string): Promise<void>;
}

interface ReminderDispatcherDependencies {
  deliver(job: ClaimedReminder): Promise<ProactiveDeliveryReceipt>;
  repository: ReminderDispatcherRepository;
  timeline: Pick<TelegramGroupJournalRepository, "recordAgentResponse">;
}

export function createReminderDispatcher(dependencies: ReminderDispatcherDependencies) {
  return async function dispatchReminders(now = new Date()): Promise<number> {
    const jobs = await dependencies.repository.claimDue({
      leaseMilliseconds: REMINDER_DISPATCH_LEASE_MILLISECONDS,
      limit: REMINDER_DISPATCH_BATCH_SIZE,
      now,
    });

    const persistenceErrors: unknown[] = [];
    // Sequential delivery bounds Telegram pressure and gives every lease an unambiguous marker order.
    for (const job of jobs) {
      let completedAt: Date;
      let receipt: ProactiveDeliveryReceipt;
      let delivered = false;
      try {
        await dependencies.repository.markDispatchStarted(job.id, job.leaseToken);
        receipt = await dependencies.deliver(job);
        delivered = true;
        completedAt = new Date();
        // Completion atomically records the proactive receipt before any secondary projection.
        // Telegram already has the message: a dropped connection retries only this receipt, and
        // a receipt that did commit is recognized by the repository (upstream 2167e2c).
        const sent = receipt;
        const at = completedAt;
        await recoverDatabaseBookkeeping(() => dependencies.repository.complete(job, at, sent));
      } catch (error) {
        if (delivered && isTransientDatabaseConnectionError(error)) {
          // Not a delivery failure. The lease with its dispatch marker expires into the
          // ambiguous path, which never re-sends.
          persistenceErrors.push(error);
          continue;
        }
        // Недоказанная аудитория и снятая аренда одинаково означают «ничего не отправлено»:
        // строку уже перевёл тот, кто их обнаружил, и терминальная отметка её только потеряет.
        if (isAppError(error) && (error.code === "AGENT_REMINDER_LEASE_STALE" ||
          error.code === "AGENT_REMINDER_DESTINATION_UNPROVEN")) {
          console.error(JSON.stringify({
            code: error.code,
            message: "Reminder lease changed before delivery completed",
            reminderId: job.id,
          }));
          continue;
        }
        const errorCode = isAppError(error)
          ? error.code
          : "AGENT_REMINDER_TELEGRAM_DELIVERY_FAILED";
        try {
          await dependencies.repository.fail(job, errorCode);
        } catch (persistenceError) {
          persistenceErrors.push(persistenceError);
        }
        continue;
      }
      if (job.groupId) {
        // Finish the claimed batch before reporting a journal outage. Otherwise unrelated
        // reminders remain leased until expiry despite never reaching their send boundary.
        try {
          await dependencies.timeline.recordAgentResponse({
            applicationSessionId: null,
            contentText: receipt.text,
            deliveredAt: completedAt,
            groupId: job.groupId,
            messageThreadId: job.forumTopicId,
            replyToEntryId: null,
            telegramMessageIds: [receipt.messageId],
          });
        } catch (error) {
          persistenceErrors.push(error);
        }
      }
    }
    if (persistenceErrors.length === 1) throw persistenceErrors[0];
    if (persistenceErrors.length > 1) {
      throw new AggregateError(persistenceErrors, "Reminder batch persistence failed");
    }
    return jobs.length;
  };
}

export const dispatchDueReminders = createReminderDispatcher({
  deliver: deliverTelegramReminder,
  repository: reminderDispatchRepository,
  timeline: telegramGroupJournalRepository,
});
