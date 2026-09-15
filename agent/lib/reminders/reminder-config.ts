/**
 * Reminder product and dispatcher limits.
 *
 * Exports:
 * - Named content, pagination, recurrence, batch, lease, and lateness constants.
 */
export const REMINDER_CONTENT_MAX_LENGTH = 1_000;
export const REMINDER_LIST_DEFAULT_LIMIT = 100;
export const REMINDER_LIST_MAX_LIMIT = 100;
export const REMINDER_RECURRENCE_INTERVAL_MAX = 365;
export const REMINDER_DISPATCH_BATCH_SIZE = 25;
export const REMINDER_DISPATCH_LEASE_MILLISECONDS = 5 * 60_000;
export const REMINDER_DISPATCH_LATE_AFTER_MILLISECONDS = 90_000;
export const REMINDER_DISPATCH_MAX_SAFE_ATTEMPTS = 3;
/** Пауза перед повторной проверкой недоказанной аудитории: столько же, сколько шаг диспетчера. */
export const REMINDER_DESTINATION_HOLD_MILLISECONDS = 60_000;
export const REMINDER_RECURRENCE_MAX_SKIPPED_OCCURRENCES = 100_000;
