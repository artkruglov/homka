/** Read-only разведка копии рабочей базы до миграции 103. Код выхода 2 — перенос запускать нельзя. */
import pg from "pg";

import { preflightLegacySpaces } from "../agent/lib/spaces/legacy-space-preflight.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  process.stderr.write(JSON.stringify({ code: "AGENT_DATABASE_CONFIG_MISSING" }) + "\n");
  process.exitCode = 1;
} else {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL statement_timeout='60s'");
      const report = await preflightLegacySpaces(client);
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      if (report.blockers.length) process.exitCode = 2;
    } finally {
      try { await client.query("ROLLBACK"); } finally { client.release(); }
    }
  } catch (error) {
    // Никаких деталей подключения, SQL и содержимого строк в операционном выводе.
    const rawCode = (error as { code?: unknown })?.code;
    const diagnostic = typeof rawCode === "string" && /^[A-Z0-9_]+$/u.test(rawCode) ? rawCode : undefined;
    process.stderr.write(JSON.stringify({ code: "AGENT_SPACE_PREFLIGHT_FAILED", diagnostic }) + "\n");
    process.exitCode = 1;
  } finally { await pool.end(); }
}
