/**
 * Typing pace of a spoken Telegram aside.
 *
 * Exports:
 * - `TELEGRAM_ASIDE_PAUSE_MAX_MILLISECONDS`: ceiling of one Telegram typing indicator.
 * - `asidePauseMilliseconds`: pause before an aside, proportional to its visible length.
 *
 * Key construct:
 * - Telegram clears a typing indicator after five seconds, so the ceiling keeps every pause
 *   covered by exactly one chat action without a refresh loop.
 */
const TELEGRAM_ASIDE_PAUSE_BASE_MILLISECONDS = 1500;
const TELEGRAM_ASIDE_PAUSE_PER_CHARACTER_MILLISECONDS = 30;

export const TELEGRAM_ASIDE_PAUSE_MAX_MILLISECONDS = 4000;

export function asidePauseMilliseconds(text: string): number {
  const typing = TELEGRAM_ASIDE_PAUSE_BASE_MILLISECONDS +
    Array.from(text).length * TELEGRAM_ASIDE_PAUSE_PER_CHARACTER_MILLISECONDS;
  return Math.min(typing, TELEGRAM_ASIDE_PAUSE_MAX_MILLISECONDS);
}
