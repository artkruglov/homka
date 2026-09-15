/**
 * Family administration context.
 *
 * Exports:
 * - `requireFamilyCaller`: validates a family-authenticated Eve session.
 * - `requireOwner`: enforces owner-only administration.
 * - `requirePrivateTelegramOwner`: limits secret delivery to the verified owner chat.
 */
import type { SessionContext } from "eve/context";

import { AppError } from "./app-error.js";
import type { FamilyRole } from "./family-access.js";
import { resolveSessionCaller } from "./session-auth.js";

export interface FamilyCaller {
  familyId: string;
  role: FamilyRole;
  userId: string;
}

export interface PrivateTelegramOwner extends FamilyCaller {
  telegramChatId: string;
}

export function requireFamilyCaller(ctx: SessionContext): FamilyCaller {
  const caller = resolveSessionCaller(ctx);
  const familyId = caller?.attributes.familyId;
  const role = caller?.attributes.role;
  if (
    caller?.principalType !== "user" ||
    typeof familyId !== "string" ||
    !["member", "owner", "recovery_owner"].includes(String(role))
  ) {
    throw new AppError("AGENT_ACCESS_DENIED", "Требуется доступ члена семьи");
  }
  return { familyId, role: role as FamilyRole, userId: caller.principalId };
}

export function requireOwner(ctx: SessionContext): FamilyCaller {
  const caller = requireFamilyCaller(ctx);
  if (caller.role !== "owner") {
    throw new AppError("AGENT_OWNER_REQUIRED", "Это действие доступно только владельцу");
  }
  return caller;
}

export function requirePrivateTelegramOwner(ctx: SessionContext): PrivateTelegramOwner {
  const owner = requireOwner(ctx);
  const caller = resolveSessionCaller(ctx);
  const attributes = caller?.attributes;
  if (
    caller?.authenticator !== "telegram" ||
    attributes?.telegramChatType !== "private" ||
    typeof attributes.telegramChatId !== "string"
  ) {
    throw new AppError(
      "AGENT_PRIVATE_CHAT_REQUIRED",
      "Это действие доступно только в личном чате владельца с агентом",
    );
  }
  return { ...owner, telegramChatId: attributes.telegramChatId };
}

export interface TrustedTelegramOwner extends FamilyCaller {
  chatKind: "family" | "private";
  telegramChatId: string;
}

/** Owner acting in their own private chat or in the registered family group. */
export function requireTrustedTelegramOwner(ctx: SessionContext): TrustedTelegramOwner {
  const owner = requireOwner(ctx);
  const caller = resolveSessionCaller(ctx);
  const attributes = caller?.attributes;
  const chatType = attributes?.telegramChatType;
  const chatKind = chatType === "private"
    ? "private"
    : attributes?.groupType === "family_private" ? "family" : null;
  if (
    caller?.authenticator !== "telegram" ||
    chatKind === null ||
    typeof attributes?.telegramChatId !== "string"
  ) {
    throw new AppError(
      "AGENT_TRUSTED_CHAT_REQUIRED",
      "Это действие доступно владельцу только в личном чате или семейной группе",
    );
  }
  return { ...owner, chatKind, telegramChatId: attributes.telegramChatId };
}
