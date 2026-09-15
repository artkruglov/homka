/**
 * PostgreSQL connection boundary.
 *
 * Exports:
 * - `database`: lazily initialized connection pool.
 * - `closeDatabase`: graceful shutdown helper for scripts and tests.
 */
import { Pool } from "pg";

let pool: Pool | null = null;

export function database(): Pool {
  // Resolve at first use so Eve discovery and image builds do not require runtime secrets.
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "AGENT_DATABASE_CONFIG_MISSING: Не задано подключение к базе данных",
    );
  }
  if (pool === null) {
    pool = new Pool({ connectionString, max: 10 });
    // pg-pool re-emits an idle client's socket failure on the pool. Without a listener Node turns
    // that event into an uncaught exception and the whole agent process exits; the broken client is
    // already discarded by the pool, so the next checkout reconnects. Only the code is logged:
    // PostgreSQL and socket messages may carry host or credential fragments.
    pool.on("error", reportIdleClientError);
  }
  return pool;
}

function reportIdleClientError(error: Error): void {
  console.error(JSON.stringify({
    code: "AGENT_DATABASE_POOL_ERROR",
    databaseCode: "code" in error && typeof error.code === "string" ? error.code : null,
    errorName: error.name,
  }));
}

export async function closeDatabase(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
}
