/**
 * Повторная привязка прежних записей к их областям.
 *
 * Перенос 104 связал всё, что существовало на момент миграции. Пока семья живёт в прежнем режиме,
 * каждый новый день добавляет строки без области: ход ещё не выдаёт её, а писатели честно
 * сохраняют `NULL`. Ворота переключения требуют, чтобы несвязанных строк не осталось, поэтому
 * привязку нужно повторить прямо перед переходом — она идемпотентна и чужую область не переписывает.
 *
 * Код выхода 1 — привязка не выполнена; переключение запускать нельзя.
 */
import pg from "pg";

import { bindLateSpaceRecords } from "../agent/lib/spaces/bind-late-space-records.ts";
import { backfillSpaceRecords104 } from "./migration-data/space-records-104.ts";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  process.stderr.write(JSON.stringify({ code: "AGENT_DATABASE_CONFIG_MISSING" }) + "\n");
  process.exitCode = 1;
} else {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout='600s'");
      const report = await backfillSpaceRecords104(client);
      // Таблицы, появившиеся после заморозки 104, связываются своим проходом по живому каталогу.
      const late = await bindLateSpaceRecords(client);
      await client.query("COMMIT");
      process.stdout.write(JSON.stringify({
        boundRows: report.updatedRows + late.updatedRows,
        tables: {
          ...Object.fromEntries(
            Object.entries(report.tables)
              .filter(([, counts]) => counts.updatedRows > 0)
              .map(([table, counts]) => [table, counts.updatedRows]),
          ),
          ...Object.fromEntries(
            Object.entries(late.tables).filter(([, rows]) => rows > 0),
          ),
        },
      }, null, 2) + "\n");
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* соединение уже потеряно */ }
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    process.stderr.write(JSON.stringify({
      code: "AGENT_SPACE_BINDING_FAILED",
      message: error instanceof Error ? error.message : String(error),
    }) + "\n");
    process.exitCode = 1;
  } finally { await pool.end(); }
}
