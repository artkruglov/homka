/**
 * Bounded observation of an Eve session stream at the Telegram ingress boundary.
 *
 * Exports:
 * - `EveSessionResult`: the part of the dispatched Eve session the ingress reads.
 * - `waitForSessionBoundary`: resolves the next stream cursor at the turn boundary, or fails with
 *   a stable code when the stream closes without one or stays silent for the idle window.
 * - `isLostSessionBoundary`: the failures after which the session cursor cannot be trusted.
 */
import { AppError, isAppError } from "./app-error.js";

export interface EveSessionResult {
  getEventStream(options?: { startIndex?: number }): Promise<ReadableStream<{ type: string }>>;
  id: string;
}

const LOST_BOUNDARY_CODES = new Set([
  "AGENT_TELEGRAM_SESSION_BOUNDARY_MISSING",
  "AGENT_TELEGRAM_SESSION_BOUNDARY_TIMEOUT",
]);

export function isLostSessionBoundary(error: unknown): boolean {
  return isAppError(error) && LOST_BOUNDARY_CODES.has(error.code);
}

function isBoundaryEvent(type: string): boolean {
  return type === "session.waiting" || type === "session.completed" || type === "session.failed";
}

/**
 * Without a bound, a session that never reports its state kept the lease heartbeat renewing and
 * held one of the few drain loops forever; three such turns silenced the whole bot (upstream
 * incident 2026-09-02). The window is idle time, not turn length: every event of the current turn,
 * including the wrapped events of an inline child agent, starts it again.
 */
export async function waitForSessionBoundary(
  session: EveSessionResult,
  startIndex: number,
  options: {
    /** Whether the Eve session still has unanswered prompts after the delivered answer. */
    hasPendingApprovals?: () => Promise<boolean>;
    idleMilliseconds: number;
    updateId: string;
  },
): Promise<number> {
  let reader: ReadableStreamDefaultReader<{ type: string }> | undefined;
  let cancellation: Promise<void> | undefined;
  let timedOut = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let expire: (() => void) | undefined;

  function cancelReader(): Promise<void> | undefined {
    if (!reader) return undefined;
    const active = reader;
    cancellation ??= active.cancel().finally(() => active.releaseLock());
    return cancellation;
  }

  const refreshIdle = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => expire?.(), options.idleMilliseconds);
  };

  const consume = async (): Promise<number> => {
    const stream = await session.getEventStream({ startIndex });
    reader = stream.getReader();
    let completedCursor: number | undefined;
    try {
      // The stream may open only after the deadline; close that late reader instead of reading it.
      if (timedOut) return startIndex;
      let nextEventIndex = startIndex;
      while (true) {
        const event = await reader.read();
        if (event.done || timedOut) break;
        nextEventIndex += 1;
        refreshIdle();
        if (isBoundaryEvent(event.value.type)) {
          completedCursor = nextEventIndex;
          return nextEventIndex;
        }
        if (
          event.value.type === "approval.settled" &&
          options.hasPendingApprovals !== undefined &&
          await options.hasPendingApprovals()
        ) {
          // Eve resumes a parked step only once every prompt of the session is answered, and the
          // remaining answers can arrive only through this drain. This delivery is complete.
          console.info(JSON.stringify({
            code: "AGENT_TELEGRAM_APPROVAL_BATCH_PENDING",
            sessionId: session.id,
            updateId: options.updateId,
          }));
          completedCursor = nextEventIndex;
          return nextEventIndex;
        }
      }
      throw new AppError(
        "AGENT_TELEGRAM_SESSION_BOUNDARY_MISSING",
        "Eve завершил поток без подтверждения состояния сессии Telegram",
      );
    } finally {
      try {
        await cancelReader();
      } catch (error) {
        if (completedCursor === undefined) throw error;
        // Cleanup cannot undo an observed boundary or lose its durable cursor.
        console.error(JSON.stringify({
          code: "AGENT_TELEGRAM_STREAM_CLEANUP_FAILED",
          error: error instanceof Error ? error.message : String(error),
          sessionId: session.id,
          updateId: options.updateId,
        }));
      }
    }
  };

  const deadline = new Promise<never>((_resolve, reject) => {
    expire = () => {
      timedOut = true;
      reject(new AppError(
        "AGENT_TELEGRAM_SESSION_BOUNDARY_TIMEOUT",
        "Eve не сообщил состояние сессии за отведённое время. Отправьте сообщение ещё раз",
      ));
      // The queue must not wait for a stuck cancellation; consume owns its rejection.
      void cancelReader()?.catch(() => {});
    };
  });
  refreshIdle();
  const consumption = consume();
  // A consumption that loses the race must not surface as an unhandled rejection.
  consumption.catch(() => {});
  try {
    return await Promise.race([consumption, deadline]);
  } finally {
    clearTimeout(idleTimer);
  }
}
