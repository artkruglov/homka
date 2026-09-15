/**
 * Доказательство состава Telegram-чата перед включением режима пространств.
 *
 * Без `--confirm` скрипт ничего не меняет: он печатает, кого нашёл в чате, сколько участников
 * насчитал Telegram и что мешает подтвердить состав. С `--confirm <telegram id владельца>` он
 * записывает доказательство и переводит привязку чата в подтверждённое состояние.
 *
 * Подтверждает человек, а не модель: состав берётся из базы, присутствие — из ответов Telegram,
 * а число ботов объявляет тот, кто запускает скрипт (перечислить их Bot API не даёт).
 *
 * Код выхода 2 — состав не доказан.
 */
import { callTelegramApi } from "eve/channels/telegram";
import pg from "pg";

import {
  commitAudienceProof,
  planAudienceProof,
  type AudienceProofDependencies,
} from "../agent/lib/spaces/audience-proof-flow.ts";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const chatId = argument("chat");
const declaredBotCount = Number(argument("bots") ?? "1");
const confirmBy = argument("confirm");
const connectionString = process.env.DATABASE_URL;

async function call(method: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await callTelegramApi({
    method,
    body: body as never,
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }),
  });
  const payload = response.body as { ok?: unknown; result?: unknown } | null;
  return response.ok && payload?.ok === true ? payload.result : null;
}

const telegram: AudienceProofDependencies = {
  async memberCount(chat) {
    const result = await call("getChatMemberCount", { chat_id: chat });
    return typeof result === "number" && Number.isInteger(result) && result > 0 ? result : null;
  },
  async memberStatus(chat, telegramUserId) {
    const result = await call("getChatMember", { chat_id: chat, user_id: Number(telegramUserId) });
    const status = (result as { status?: unknown } | null)?.status;
    return typeof status === "string" ? status : null;
  },
  async selfId() {
    const result = await call("getMe", {});
    const id = (result as { id?: unknown } | null)?.id;
    return typeof id === "number" ? String(id) : null;
  },
};

if (!connectionString || !chatId || !Number.isInteger(declaredBotCount) || declaredBotCount < 1) {
  process.stderr.write(JSON.stringify({ code: "AGENT_SPACE_AUDIENCE_ARGUMENTS_INVALID" }) + "\n");
  process.exitCode = 1;
} else {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout='60s'");
      // Один чат подтверждается за раз: блокировка по его идентификатору исключает гонку двух
      // подтверждений с разными наблюдениями счётчика.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [chatId]);
      const plan = await planAudienceProof(client, telegram, { declaredBotCount, telegramChatId: chatId });
      const report = {
        ...plan,
        members: plan.members.map((member) => ({
          displayName: member.displayName, present: member.present,
        })),
      };
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      if (plan.blockers.length > 0) {
        await client.query("ROLLBACK");
        process.exitCode = 2;
      } else if (confirmBy === undefined) {
        await client.query("ROLLBACK");
        process.stdout.write("Состав доказан. Повторите с --confirm <telegram id владельца>.\n");
      } else {
        const owner = await client.query<{ id: string }>(
          "SELECT id FROM users WHERE telegram_user_id = $1", [confirmBy],
        );
        if (!owner.rows[0]) throw new Error("AGENT_SPACE_AUDIENCE_CONFIRMER_UNKNOWN");
        await commitAudienceProof(client, plan, owner.rows[0].id);
        await client.query("COMMIT");
        process.stdout.write("Состав подтверждён, привязка чата активна.\n");
      }
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* соединение уже потеряно */ }
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    // Никаких токенов, SQL и содержимого чата в операционном выводе.
    process.stderr.write(JSON.stringify({
      code: "AGENT_SPACE_AUDIENCE_PROOF_FAILED",
      errorName: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : undefined,
    }) + "\n");
    process.exitCode = 1;
  } finally { await pool.end(); }
}
