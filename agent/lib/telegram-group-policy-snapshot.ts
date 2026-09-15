/**
 * Registered Telegram group policy snapshot comparison.
 *
 * Exports:
 * - `sameTelegramGroupPolicy`: detects trust-zone changes between journaling and dispatch.
 */
import type { RegisteredGroup } from "./family-access.js";

export function sameTelegramGroupPolicy(
  left: RegisteredGroup,
  right: RegisteredGroup | null,
): boolean {
  if (!right) return false;
  if (
    left.familyId !== right.familyId || left.groupId !== right.groupId ||
    left.messageMode !== right.messageMode || left.telegramChatId !== right.telegramChatId ||
    left.type !== right.type || left.toolAllowlist.length !== right.toolAllowlist.length
  ) return false;
  return left.toolAllowlist.every((capability, index) => capability === right.toolAllowlist[index]);
}
