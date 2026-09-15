/**
 * Передача сообщения в другой чат по просьбе человека.
 *
 * Экспорт:
 * - `RelayTarget`, `listRelayTargets`: чаты, в которые этот человек может попросить передать.
 * - `relayMessage`: одна передача с заявкой, проверкой аудитории и записью в журнал чата.
 *
 * Это не «бот пишет от себя»: у сообщения есть автор, точный текст, который он подтвердил, и
 * адресат, выбранный из его собственных чатов. Бот подписывает передачу именем автора, потому что
 * в общем чате должно быть видно, чья это просьба, а не казаться, что помощница решила сама.
 *
 * Адресат приходит непрозрачной ссылкой из перечисления, а не идентификатором чата из текста
 * модели, и перед самой отправкой проверяется заново: человек всё ещё состоит в этом чате, чат всё
 * ещё зарегистрирован, а состав его аудитории подтверждён.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { boundChatSpace } from "../spaces/active-space.js";
import { authorizeSpaceDelivery } from "../spaces/space-delivery-authorization.js";
import { isCurrentTelegramMember } from "../telegram-current-membership.js";

export interface RelayTarget {
  readonly targetRef: string;
  readonly title: string;
}

export interface RelayOutcome {
  readonly delivered: boolean;
  readonly replayed: boolean;
  readonly targetTitle: string;
  readonly text: string;
}

interface RelayDependencies {
  membership: typeof isCurrentTelegramMember;
  send(input: { chatId: string; text: string }): Promise<string>;
}

function denied(): never {
  throw new AppError(
    "AGENT_RELAY_TARGET_UNAVAILABLE",
    "Передать в этот чат нельзя: выберите его из списка доступных",
  );
}

function requirePrivateAuthor(auth: MemoryAuthorization): string {
  // Просьба передаётся из своего чата: в самой группе передавать нечего, человек уже в ней.
  if (auth.groupId !== null || !auth.userId || !auth.telegramUserId || auth.role === "external") {
    throw new AppError(
      "AGENT_RELAY_CHAT_INVALID",
      "Передать сообщение можно из личного чата: в общем чате вы и так пишете сами",
    );
  }
  return auth.userId;
}

/** Живое членство подтверждает Telegram, а не прежняя регистрация: состав чата меняется. */
async function targetsOf(
  client: PoolClient,
  auth: MemoryAuthorization,
  membership: RelayDependencies["membership"],
  only: string | null,
): Promise<{ id: string; telegram_chat_id: string; title: string }[]> {
  const rows = (await client.query<{ id: string; telegram_chat_id: string; title: string }>(
    `SELECT id, telegram_chat_id, title FROM telegram_groups
      WHERE family_id = $1 AND type = 'family_private' AND ($2::uuid IS NULL OR id = $2::uuid)
      ORDER BY title, id LIMIT 20`,
    [auth.familyId, only],
  )).rows;
  const checked = await Promise.all(rows.map(async (row) =>
    await membership(row.telegram_chat_id, auth.telegramUserId!) ? row : null));
  return checked.filter((row): row is typeof rows[number] => row !== null);
}

export async function listRelayTargets(auth: MemoryAuthorization): Promise<RelayTarget[]> {
  requirePrivateAuthor(auth);
  const client = await database().connect();
  try {
    const rows = await targetsOf(client, auth, isCurrentTelegramMember, null);
    return rows.map((row) => ({ targetRef: row.id, title: row.title }));
  } finally {
    client.release();
  }
}

export function createChatRelay(dependencies: RelayDependencies) {
  return async function relay(
    auth: MemoryAuthorization,
    input: { targetRef: string; text: string },
    operationKey: string,
  ): Promise<RelayOutcome> {
    const authorId = requirePrivateAuthor(auth);
    const client = await database().connect();
    let claim: { id: string; text: string; title: string; chatId: string; spaceId: string | null };
    try {
      await client.query("BEGIN");
      const [target] = await targetsOf(client, auth, dependencies.membership, input.targetRef);
      if (!target) denied();
      const area = await boundChatSpace(client, auth.familyId, target.id);
      const author = (await client.query<{ display_name: string }>(
        "SELECT display_name FROM users WHERE id = $1", [authorId],
      )).rows[0];
      if (!author) denied();
      // Подпись обязательна: в общем чате видно, чья это просьба, а не решение помощницы.
      const text = `Передаю по просьбе ${author.display_name}:\n\n${input.text}`;
      const existing = (await client.query<{
        diagnostic_code: string | null; group_id: string; id: string; status: string;
        telegram_message_id: string | null; text: string;
      }>(
        `SELECT id,status,text,group_id,diagnostic_code,telegram_message_id
           FROM chat_message_relays WHERE family_id=$1 AND operation_key=$2`,
        [auth.familyId, operationKey],
      )).rows[0];
      if (existing) {
        await client.query("COMMIT");
        // Тот же ключ с другим адресатом это другая просьба, а не повтор прежней.
        if (existing.group_id !== target.id) {
          throw new AppError(
            "AGENT_RELAY_OPERATION_CONFLICT",
            "Этот же запрос уже передавался в другой чат. Повторите просьбу заново",
          );
        }
        // Заявка написана, а исход не записан: процесс погиб между ними, и что стало с
        // сообщением, неизвестно. Назвать это отказом значило бы пообещать, что не ушло.
        if (existing.status === "started" ||
          existing.diagnostic_code === "AGENT_RELAY_DELIVERY_AMBIGUOUS") {
          throw new AppError(
            "AGENT_RELAY_OUTCOME_UNKNOWN",
            "Неизвестно, дошло ли это сообщение. Посмотрите чат, прежде чем отправлять заново",
          );
        }
        // Повтор того же вызова не отправляет второе сообщение: исход уже записан.
        if (existing.status === "failed") {
          throw new AppError("AGENT_RELAY_DELIVERY_FAILED", "Сообщение не было передано, попробуйте заново");
        }
        return {
          delivered: existing.status === "delivered",
          replayed: true,
          targetTitle: target.title,
          text: existing.text,
        };
      }
      const claimed = (await client.query<{ id: string }>(
        `INSERT INTO chat_message_relays
           (family_id, space_id, group_id, author_user_id, operation_key, text)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [auth.familyId, area?.spaceId ?? null, target.id, authorId, operationKey, text],
      )).rows[0]!;
      claim = {
        chatId: target.telegram_chat_id, id: claimed.id, spaceId: area?.spaceId ?? null,
        text, title: target.title,
      };
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    // Аудитория адресата проверяется тем же швом, что и обычный ответ: чат с неподтверждённым
    // составом не получает содержимое, даже когда его просит собственный участник.
    const audience = await authorizeSpaceDelivery({
      chatType: "supergroup",
      familyId: auth.familyId,
      groupId: input.targetRef,
      now: new Date(),
      ...(claim.spaceId === null
        ? {}
        : { space: await currentAreaPolicy(claim.spaceId) }),
      userId: authorId,
    });
    if (!audience.allowed) {
      await settle(claim.id, "failed", null, audience.code);
      throw new AppError(
        "AGENT_RELAY_AUDIENCE_UNPROVEN",
        "Состав этого чата не подтверждён, сообщение не отправлено",
      );
    }
    try {
      const messageId = await dependencies.send({ chatId: claim.chatId, text: claim.text });
      await settle(claim.id, "delivered", messageId, null);
      return { delivered: true, replayed: false, targetTitle: claim.title, text: claim.text };
    } catch (error) {
      // Неясный исход остаётся неясным: автоматического повтора нет, человек решает сам.
      await settle(claim.id, "failed", null, "AGENT_RELAY_DELIVERY_AMBIGUOUS");
      throw error;
    }
  };
}

async function currentAreaPolicy(spaceId: string): Promise<{ policyVersion: number; spaceId: string }> {
  const row = (await database().query<{ policy_version: number }>(
    "SELECT policy_version FROM spaces WHERE id = $1", [spaceId],
  )).rows[0];
  if (!row) denied();
  return { policyVersion: row.policy_version, spaceId };
}

async function settle(
  id: string,
  status: "delivered" | "failed",
  messageId: string | null,
  diagnosticCode: string | null,
): Promise<void> {
  await database().query(
    `UPDATE chat_message_relays
        SET status = $2, telegram_message_id = $3, diagnostic_code = $4, completed_at = now()
      WHERE id = $1 AND status = 'started'`,
    [id, status, messageId, diagnosticCode],
  );
}
