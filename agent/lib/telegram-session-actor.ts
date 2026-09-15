/**
 * Telegram actor recovery from verified Eve session auth.
 *
 * Exports:
 * - `TelegramSessionActor`: normalized durable user, bot, or channel actor identity.
 * - `resolveTelegramSessionActor`: validates explicit durable user, bot, or channel actor attributes.
 * - `isTelegramChannelSession`: exact channel-service predicate for authorization boundaries.
 */
import type { SessionAuth } from "eve/context";

import type { TelegramActorKind } from "./telegram-inbound-actor.js";

export interface TelegramSessionActor {
  id: string;
  kind: TelegramActorKind;
}

export function resolveTelegramSessionActor(auth: SessionAuth): TelegramSessionActor | null {
  const caller = auth.current;
  const attributes = caller?.attributes;
  if (!caller || !attributes) return null;
  const actorKind = attributes?.telegramActorKind;
  const actorId = attributes?.telegramActorId;

  if (actorKind === "telegram_channel") {
    const valid = caller.authenticator === "telegram" && caller.principalType === "service" &&
      typeof actorId === "string" && /^-[0-9]+$/u.test(actorId) &&
      attributes.telegramUserId === undefined && caller.principalId === `telegram-channel:${actorId}`;
    return valid ? { id: actorId, kind: actorKind } : null;
  }
  // Another bot is a service principal named by its Telegram id; it never carries a user identity.
  if (actorKind === "telegram_bot") {
    const valid = caller.authenticator === "telegram" && caller.principalType === "service" &&
      typeof actorId === "string" && /^[0-9]+$/u.test(actorId) &&
      attributes.telegramUserId === undefined && caller.principalId === `telegram-bot:${actorId}`;
    return valid ? { id: actorId, kind: actorKind } : null;
  }
  if (actorKind === "telegram_user") {
    const telegramUserId = attributes.telegramUserId;
    const valid = caller.principalType === "user" && typeof actorId === "string" &&
      actorId === telegramUserId;
    return valid ? { id: actorId, kind: actorKind } : null;
  }

  // Sessions without the explicit actor contract are intentionally invalidated at this boundary.
  return null;
}

export function isTelegramChannelSession(auth: SessionAuth): boolean {
  return resolveTelegramSessionActor(auth)?.kind === "telegram_channel";
}
