/**
 * Разрешение отправить содержимое области в Telegram-чат.
 *
 * Экспорт:
 * - `SpaceDeliveryRequest`: проверенный чат хода и доказанная им область.
 * - `SpaceDeliveryDecision`: разрешено или отказ с кодом.
 * - `authorizeSpaceDelivery`: решение непосредственно перед отправкой, без обращения к Telegram.
 * - `spaceDeliveryRequestFromAuth`: разбор проверенных атрибутов хода.
 * - `notifySuspendedDelivery`: владелец узнаёт о приостановке сразу и без текста ответа.
 *
 * Право инициатора и адресат сообщения — разные проверки. Инициатора проверяет авторизация хода,
 * а здесь проверяется, кто это прочитает: состав чата доказан, доказательство принадлежит этой
 * области и этой версии политики, и оно свежее.
 *
 * Отказ возвращается, а не бросается: бросок стал бы `turn.failed`, и человек получил бы второе
 * сообщение — в чат, аудитория которого как раз и не подтверждена. К Telegram здесь не
 * обращаются: строка доказательства читается в той же транзакции, что и проверка доступа.
 */
import type { PoolClient } from "pg";

import { isAppError } from "../app-error.js";
import { database } from "../database.js";
import { readFamilySpaceMode } from "./family-space-mode.js";
import { authorizeSpaceAction } from "./space-access.js";
import { readSpaceAttributes, type SpaceAttributes } from "./space-attributes.js";
import { isAudienceProven } from "./telegram-audience-proof.js";

export interface SpaceDeliveryRequest {
  readonly chatType: "group" | "private" | "supergroup";
  readonly familyId: string;
  readonly groupId: string | null;
  readonly now: Date;
  readonly space?: SpaceAttributes;
  readonly userId: string | null;
}

export type SpaceDeliveryDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: string };

const CONTEXT_REQUIRED = "AGENT_SPACE_DELIVERY_CONTEXT_REQUIRED";
const AUDIENCE_UNPROVEN = "AGENT_SPACE_DELIVERY_AUDIENCE_UNPROVEN";

async function decide(
  client: PoolClient,
  request: SpaceDeliveryRequest,
): Promise<SpaceDeliveryDecision> {
  if (await readFamilySpaceMode(client, request.familyId) !== "spaces") return { allowed: true };
  if (!request.space) return { allowed: false, code: CONTEXT_REQUIRED };
  try {
    await authorizeSpaceAction(client, {
      chat: request.groupId === null
        ? { type: "private" }
        : { groupId: request.groupId, type: request.chatType === "group" ? "group" : "supergroup" },
      familyId: request.familyId,
      policyVersion: request.space.policyVersion,
      spaceId: request.space.spaceId,
      userId: request.userId,
    }, "read");
  } catch (error) {
    if (isAppError(error)) return { allowed: false, code: error.code };
    throw error;
  }
  // У личного чата аудитория это сам аккаунт: доказывать в нём нечего и некого.
  if (request.groupId === null) return { allowed: true };
  const proven = await isAudienceProven(client, {
    groupId: request.groupId,
    now: request.now,
    policyVersion: request.space.policyVersion,
    spaceId: request.space.spaceId,
  });
  return proven ? { allowed: true } : { allowed: false, code: AUDIENCE_UNPROVEN };
}

export async function authorizeSpaceDelivery(
  request: SpaceDeliveryRequest,
): Promise<SpaceDeliveryDecision> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const decision = await decide(client, request);
    await client.query("COMMIT");
    return decision;
  } catch (error) {
    await client.query("ROLLBACK");
    // Недоступная база это не разрешение: молчание безопаснее ответа неизвестной аудитории.
    console.error(JSON.stringify({
      code: "AGENT_SPACE_DELIVERY_AUTHORIZATION_FAILED",
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
    return { allowed: false, code: "AGENT_SPACE_DELIVERY_AUTHORIZATION_FAILED" };
  } finally {
    client.release();
  }
}

/** Область, семья и чат берутся только из проверенной авторизации хода, не из текста модели. */
export function spaceDeliveryRequestFromAuth(
  caller: {
    readonly attributes?: Readonly<Record<string, unknown>>;
    readonly principalId?: string;
    readonly principalType?: string;
  } | null | undefined,
  now: Date,
): SpaceDeliveryRequest | null {
  const attributes = caller?.attributes;
  const familyId = attributes?.familyId;
  const chatType = attributes?.telegramChatType;
  if (typeof familyId !== "string") return null;
  if (chatType !== "private" && chatType !== "group" && chatType !== "supergroup") return null;
  const groupId = typeof attributes?.groupId === "string" ? attributes.groupId : null;
  // Ход внешней группы и ход, начатый другим ботом, личности не несут: их аудиторию доказывает
  // только привязка чата, и членство в области у них не проверяется.
  const userId = caller?.principalType === "user" && attributes?.role !== "external"
    ? caller.principalId ?? null
    : null;
  const space = readSpaceAttributes(attributes, "AGENT_SPACE_DELIVERY_CONTEXT_REQUIRED");
  return {
    chatType,
    familyId,
    groupId: chatType === "private" ? null : groupId,
    now,
    ...(space ? { space } : {}),
    userId,
  };
}

/**
 * Владелец узнаёт о приостановке сразу: приостановленный ответ не уходит и после подтверждения
 * состава, поэтому человек в чате остаётся без ответа и должен спросить заново. Сообщение
 * содержит только код и чат, но не текст ответа: аудитория этого чата как раз и не подтверждена.
 */
export async function notifySuspendedDelivery(input: {
  code: string;
  deliver: (message: { chatId: string; text: string }) => Promise<void>;
  familyId: string;
  telegramChatId: string;
}): Promise<void> {
  try {
    const owner = (await database().query<{ telegram_user_id: string }>(
      `SELECT users.telegram_user_id FROM family_memberships AS membership
         JOIN users ON users.id = membership.user_id
        WHERE membership.family_id = $1 AND membership.role = 'owner'
        ORDER BY users.telegram_user_id LIMIT 1`,
      [input.familyId],
    )).rows[0];
    if (!owner) return;
    await input.deliver({
      chatId: owner.telegram_user_id,
      text: `Ответ в чате ${input.telegramChatId} не отправлен: состав чата не подтверждён (${input.code}).` +
        " После подтверждения он не уходит сам — попросите задать вопрос заново.",
    });
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_SPACE_DELIVERY_SUSPENSION_NOTICE_FAILED",
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
  }
}
