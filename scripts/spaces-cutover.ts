/**
 * Переключение семьи на режим пространств и откат обратно.
 *
 * `npm run spaces:cutover -- --family <uuid> --reason "..." [--owner <telegram id>] [--revert]`
 * `--prepare-only` закрывает legacy-сессии и подготавливает контексты для аудита без переключения.
 * Использовать на копии или при остановленных production writers; с `--revert` несовместим.
 *
 * Скрипт, а не инструмент модели: это операция над всей установкой, у неё нет автора-собеседника.
 * Ворота перехода живут в триггере базы, поэтому обойти их отсюда нельзя; здесь выполняется то,
 * что обязано случиться в одной транзакции с самим переключением.
 *
 * Первым идёт повторная привязка прежних записей: перенос 104 связал только то, что существовало
 * на момент миграции, а каждый день прежнего режима добавляет строки без области. Привязка
 * идемпотентна и чужую область не переписывает, поэтому её безопасно повторить здесь.
 *
 * Код выхода 2 — переход или откат запрещён состоянием данных.
 */
import pg from "pg";

import {
  performSpacesCutover,
  prepareSpacesCutover,
  revertSpacesCutover,
} from "../agent/lib/spaces/spaces-cutover.ts";
import { bindLateSpaceRecords } from "../agent/lib/spaces/bind-late-space-records.ts";
import { backfillSpaceRecords104 } from "./migration-data/space-records-104.ts";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const familyId = argument("family");
const reason = argument("reason");
const ownerTelegramId = argument("owner");
const revert = process.argv.includes("--revert");
const prepareOnly = process.argv.includes("--prepare-only");
const connectionString = process.env.DATABASE_URL;

if (!connectionString || !familyId || !reason || (revert && prepareOnly)) {
  process.stderr.write(JSON.stringify({ code: "AGENT_SPACE_CUTOVER_ARGUMENTS_INVALID" }) + "\n");
  process.exitCode = 1;
} else {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout='120s'");
      const changedBy = ownerTelegramId === undefined ? null : (await client.query<{ id: string }>(
        `SELECT users.id FROM users
           JOIN family_memberships AS membership ON membership.user_id = users.id
          WHERE users.telegram_user_id = $1 AND membership.family_id = $2
            AND membership.role IN ('owner','recovery_owner')`,
        [ownerTelegramId, familyId],
      )).rows[0]?.id ?? null;
      if (ownerTelegramId !== undefined && changedBy === null) {
        throw new Error("AGENT_SPACE_CUTOVER_OWNER_UNKNOWN");
      }
      const input = { changedBy, familyId, now: new Date(), reason };
      const bound = revert ? null : await backfillSpaceRecords104(client);
      // Покупки и переданные сообщения появились после заморозки 104: без своего прохода их
      // строки остались бы несвязанными, и ворота перехода не открылись бы никогда.
      const late = revert ? null : await bindLateSpaceRecords(client);
      const report = revert
        ? await revertSpacesCutover(client, input)
        : prepareOnly
          ? { ...await prepareSpacesCutover(client, input), familyId, mode: "legacy", prepared: true }
          : await performSpacesCutover(client, input);
      await client.query("COMMIT");
      process.stdout.write(JSON.stringify({
        ...report,
        ...(bound === null || late === null
          ? {}
          : { boundRows: bound.updatedRows + late.updatedRows }),
      }, null, 2) + "\n");
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* соединение уже потеряно */ }
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(JSON.stringify({
      code: "AGENT_SPACE_CUTOVER_FAILED",
      message,
    }) + "\n");
    process.exitCode = /AGENT_SPACE_(CUTOVER|ROLLBACK)_/u.test(message) ? 2 : 1;
  } finally { await pool.end(); }
}
