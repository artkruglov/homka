/** Pace the persistence sink so Eve's native ordered emitter coalesces adjacent deltas in memory. */
const DELTA_PERSIST_INTERVAL_MS = 250;

export function paceDeltaSink<E extends { type: string }, M>(sink: (event: E, messages?: M) => Promise<void>) {
  let nextDeltaAt = 0;
  return async (event: E, messages?: M): Promise<void> => {
    if (event.type === "reasoning.appended" || event.type === "message.appended") {
      const delay = nextDeltaAt - Date.now();
      if (delay > 0) await new Promise<void>(resolve => setTimeout(resolve, delay));
      nextDeltaAt = Date.now() + DELTA_PERSIST_INTERVAL_MS;
    }
    await sink(event, messages);
  };
}
