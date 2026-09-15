/**
 * Проверка восстановленной копии до старта воркеров.
 *
 * `npm run verify:rollback` — только отчёт; `-- --suppress` снимает найденные сигналы.
 *
 * Восстановление дампа возвращает очередь Telegram, просроченные напоминания и расписания и живые
 * сессии. Всё это срабатывает лавиной при первом запуске, а отправленное уже не отзывается,
 * поэтому подавление идёт до старта воркеров, а не после первой жалобы.
 *
 * Код выхода 2 — сигналы остались, поднимать стек нельзя.
 */
import pg from "pg";

import {
  suppressAfterRestore,
  verifyClosedRollback,
} from "../agent/lib/spaces/closed-rollback.ts";

const connectionString = process.env.DATABASE_URL;
const suppress = process.argv.includes("--suppress");

if (!connectionString) {
  process.stderr.write(JSON.stringify({ code: "AGENT_DATABASE_CONFIG_MISSING" }) + "\n");
  process.exitCode = 1;
} else {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout='120s'");
      const report = suppress
        ? await suppressAfterRestore(client, new Date())
        : await verifyClosedRollback(client, new Date());
      if (suppress) await client.query("COMMIT");
      else await client.query("ROLLBACK");
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      if (report.blockers.length > 0) process.exitCode = 2;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* соединение уже потеряно */ }
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    process.stderr.write(JSON.stringify({
      code: "AGENT_ROLLBACK_VERIFICATION_FAILED",
      errorName: error instanceof Error ? error.name : "UnknownError",
    }) + "\n");
    process.exitCode = 1;
  } finally { await pool.end(); }
}
