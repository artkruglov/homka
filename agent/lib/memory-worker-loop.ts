/**
 * Graceful background memory worker process loop.
 *
 * Export:
 * - `runMemoryWorkerLoop`: publishes readiness after one successful step, then loops until shutdown.
 */
import { setTimeout as sleep } from "node:timers/promises";

export async function runMemoryWorkerLoop(input: {
  close(): Promise<void>;
  idleMilliseconds: number;
  markReady(): Promise<void>;
  processNext(): Promise<boolean>;
  signal: AbortSignal;
}): Promise<void> {
  let ready = false;
  try {
    while (!input.signal.aborted) {
      const processed = await input.processNext();
      if (!ready && !input.signal.aborted) {
        // Container health remains blocked until catch-up and every earlier durable phase succeed.
        await input.markReady();
        ready = true;
      }
      if (processed || input.signal.aborted) continue;
      try {
        await sleep(input.idleMilliseconds, undefined, { signal: input.signal });
      } catch (error) {
        if (!input.signal.aborted) throw error;
      }
    }
  } finally {
    await input.close();
  }
}
