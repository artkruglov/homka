/**
 * Recovery of replay-safe bookkeeping writes from a lost PostgreSQL connection.
 *
 * Exports:
 * - `isTransientDatabaseConnectionError`: the connection was lost, refused or terminated by the
 *   server; the statement's own logic did not fail.
 * - `recoverDatabaseBookkeeping`: retries an idempotent database-only write a few times with backoff.
 *
 * Key construct:
 * - Only for writes that record an effect which already happened (a Telegram message was sent,
 *   Eve accepted a run) and that are safe to repeat: never wrap the side effect itself. Without
 *   this a restart of PostgreSQL between the send and its receipt turned a delivered recurring
 *   reminder into a terminal ambiguous failure (upstream 2167e2c).
 */
import { isAppError } from "./app-error.js";

// SQLSTATE class 08 (connection exception), server shutdown/crash and connection slots exhausted.
const TRANSIENT_SQLSTATES = new Set(["08000", "08001", "08003", "08004", "08006", "08007", "08P01", "57P01", "57P02", "57P03", "53300"]);
// Node socket codes surface raw from node-postgres when the server is unreachable or resets.
const TRANSIENT_SOCKET_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH"]);
// node-postgres reports a dropped client by message, without a code.
const TRANSIENT_PG_MESSAGES = [
  "Connection terminated unexpectedly",
  "Connection terminated",
  "Client has encountered a connection error and is not queryable",
  "timeout exceeded when trying to connect",
];

/** Retry delays: the number of entries is the number of recoveries after the first attempt. */
export const DATABASE_BOOKKEEPING_RETRY_DELAYS_MS = [1_000, 3_000, 9_000] as const;

/**
 * Socket codes are only meaningful for errors thrown by a database-only operation: an HTTP client
 * reports the same ECONNRESET, so do not apply this to an operation that also calls a network API.
 */
export function isTransientDatabaseConnectionError(error: unknown, depth = 0): boolean {
  if (!(error instanceof Error) || isAppError(error) || depth > 5) return false;
  const code = "code" in error ? (error as { code?: unknown }).code : undefined;
  if (typeof code === "string" && (TRANSIENT_SQLSTATES.has(code) || TRANSIENT_SOCKET_CODES.has(code))) return true;
  if (TRANSIENT_PG_MESSAGES.includes(error.message)) return true;
  if (error instanceof AggregateError && error.errors.some((inner) => isTransientDatabaseConnectionError(inner, depth + 1))) {
    return true;
  }
  return error.cause !== error && isTransientDatabaseConnectionError(error.cause, depth + 1);
}

export async function recoverDatabaseBookkeeping<T>(
  operation: () => Promise<T>,
  options: { sleep?: (milliseconds: number) => Promise<unknown> } = {},
): Promise<T> {
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const delay = DATABASE_BOOKKEEPING_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isTransientDatabaseConnectionError(error)) throw error;
      console.info(JSON.stringify({ code: "AGENT_DATABASE_BOOKKEEPING_RETRY", attempt: attempt + 1, delayMs: delay }));
      await sleep(delay);
    }
  }
}
