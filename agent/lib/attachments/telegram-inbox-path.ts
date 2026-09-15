/**
 * Trusted Telegram inbox path construction.
 *
 * Export:
 * - `telegramInboxDirectory`: derives a collision-free inbox directory from authorized scope data.
 */
import { AppError } from "../app-error.js";
import type {
  WorkspaceAuthorization,
  WorkspaceScope,
} from "../workspaces/workspace-repository.js";

export function telegramInboxDirectory(
  auth: WorkspaceAuthorization,
  scope: WorkspaceScope,
  telegramMessageId: string,
): string {
  // Personal and external-group workspaces each belong to one Telegram chat, so the message ID is
  // unique inside the resolved workspace. Family storage needs the additional group namespace.
  if (scope === "personal") return `inbox/${telegramMessageId}`;
  if (
    scope === "group" &&
    auth.groupId !== null &&
    auth.groupType === "external"
  ) return `inbox/${telegramMessageId}`;

  // A family can register multiple private groups. The trusted group UUID prevents equal chat-local
  // message IDs from resolving or overwriting another group's attachment in the shared workspace.
  if (scope === "family" && auth.groupType === "family_private" && auth.groupId !== null) {
    return `inbox/groups/${auth.groupId}/${telegramMessageId}`;
  }

  throw new AppError(
    "AGENT_TELEGRAM_ATTACHMENT_SCOPE_FORBIDDEN",
    "Вложения Telegram нельзя сохранять в workspace этого чата",
  );
}
