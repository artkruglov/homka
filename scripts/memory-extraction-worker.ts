/**
 * Controller-compatible retired memory worker process.
 *
 * Constructs:
 * - Keeps the production service contract until the installed controller can remove the service.
 * - Publishes readiness and remains idle without database, embedding, or model-provider calls.
 */
import { rm, writeFile } from "node:fs/promises";

import {
  MEMORY_EXTRACTION_WORKER_IDLE_MILLISECONDS,
  MEMORY_EXTRACTION_WORKER_READY_PATH,
} from "../agent/lib/memory-config.js";
import { runMemoryWorkerLoop } from "../agent/lib/memory-worker-loop.js";
import { installSecretRedaction } from "../agent/lib/logging/redact-secrets.ts";

// Рабочий процесс пишет журналы сам: вырезание секретов ставится и здесь.
installSecretRedaction();


const shutdown = new AbortController();
process.once("SIGINT", () => shutdown.abort());
process.once("SIGTERM", () => shutdown.abort());

// A container restart reuses its writable layer, so stale readiness must be cleared before work.
await rm(MEMORY_EXTRACTION_WORKER_READY_PATH, { force: true });
await runMemoryWorkerLoop({
  close: async () => undefined,
  idleMilliseconds: MEMORY_EXTRACTION_WORKER_IDLE_MILLISECONDS,
  markReady: async () => await writeFile(
    MEMORY_EXTRACTION_WORKER_READY_PATH,
    "ready\n",
    { encoding: "utf8", mode: 0o600 },
  ),
  processNext: async () => false,
  signal: shutdown.signal,
});
