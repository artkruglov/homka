/** Preflight on a migrated database copy. Exit 2 means unresolved migration work; never applies it. */
import pg from "pg";
import { auditLegacySpaces } from "../agent/lib/spaces/legacy-space-audit.js";

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
      await client.query("SET LOCAL statement_timeout='30s'");
      const report = await auditLegacySpaces(client);
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      if (report.blockers.length) process.exitCode = 2;
    } finally {
      try { await client.query("ROLLBACK"); } finally { client.release(); }
    }
  } catch (error) {
    // Do not put connection details, SQL, payloads or retained content into operational output.
    const rawCode = (error as { code?: unknown })?.code;
    const diagnostic = typeof rawCode === "string" && /^[A-Z0-9_]+$/u.test(rawCode) ? rawCode : undefined;
    process.stderr.write(JSON.stringify({ code: "AGENT_SPACE_AUDIT_FAILED", diagnostic }) + "\n");
    process.exitCode = 1;
  } finally { await pool.end(); }
}
