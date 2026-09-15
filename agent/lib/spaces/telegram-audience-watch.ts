/**
 * Минутная сверка счётчика участников чата.
 *
 * Экспорт:
 * - `AUDIENCE_COUNT_CHECK_INTERVAL_MILLISECONDS`: как часто чат спрашивают о числе участников.
 * - `createTelegramAudienceWatch` / `refreshTelegramAudienceCount`: сверка на старте хода.
 *
 * События `chat_member` Eve отбрасывает до приложения, поэтому за составом следит счётчик:
 * `getChatMemberCount` ловит и вход, и выход в пределах минуты, а события дали бы только скорость.
 *
 * Неудачный запрос не отзывает разрешение: он ничего не доказывает ни в одну сторону. Разрешение
 * в этом случае истекает само по окну свежести доказательства — молчание провайдера не повод
 * отправлять содержимое области в чат, состав которого не подтверждён уже четверть часа.
 */
import type { PoolClient } from "pg";

import { database } from "../database.js";
import { noteObservedMemberCount, readAudienceProof } from "./telegram-audience-proof.js";

export const AUDIENCE_COUNT_CHECK_INTERVAL_MILLISECONDS = 60_000;

interface AudienceWatchDependencies {
  memberCount(chatId: string): Promise<number | null>;
  noteCount(input: {
    count: number; familyId: string; groupId: string; now: Date;
  }): Promise<"matched" | "revoked" | "unproven">;
  readProof(groupId: string): Promise<{ checkedAt: Date } | null>;
}

export interface AudienceWatchInput {
  readonly familyId: string;
  readonly groupId: string;
  readonly now: Date;
  readonly telegramChatId: string;
}

export function createTelegramAudienceWatch(dependencies: AudienceWatchDependencies) {
  return async function refresh(input: AudienceWatchInput): Promise<"checked" | "revoked" | "skipped"> {
    const proof = await dependencies.readProof(input.groupId);
    // Без доказательства сверять нечего: доставка в такой чат и так остановлена.
    if (proof === null) return "skipped";
    if (input.now.getTime() - proof.checkedAt.getTime() < AUDIENCE_COUNT_CHECK_INTERVAL_MILLISECONDS) {
      return "skipped";
    }
    const count = await dependencies.memberCount(input.telegramChatId);
    if (count === null) return "skipped";
    const outcome = await dependencies.noteCount({
      count, familyId: input.familyId, groupId: input.groupId, now: input.now,
    });
    return outcome === "revoked" ? "revoked" : "checked";
  };
}

async function withTransaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export interface TelegramCountRequest {
  (method: string, body: { chat_id: string }): Promise<{ body: unknown; ok: boolean }>;
}

export function telegramAudienceWatch(request: TelegramCountRequest) {
  return createTelegramAudienceWatch({
    async memberCount(chatId) {
      try {
        const response = await request("getChatMemberCount", { chat_id: chatId });
        const body = response.body as { ok?: unknown; result?: unknown } | null;
        if (!response.ok || body?.ok !== true) return null;
        const count = body.result;
        return typeof count === "number" && Number.isInteger(count) && count > 0 ? count : null;
      } catch {
        return null;
      }
    },
    noteCount: (note) => withTransaction((client) => noteObservedMemberCount(client, note)),
    readProof: (groupId) => withTransaction((client) => readAudienceProof(client, groupId)),
  });
}
