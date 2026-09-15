/**
 * Turn preparation timing log.
 *
 * Exports:
 * - `logTurnTiming`: one `AGENT_TURN_TIMING` line with the stage name and its duration.
 * - `timed`: runs a stage and logs its duration, rethrowing any failure untouched.
 *
 * Key construct:
 * - Reply latency had a 3–7 second hole between the prepared inbound context and the first model
 *   request that no log explained (9 сентября 2026). Each preparation stage now reports how long it
 *   took, so the hole is attributed from `docker logs` instead of guessed.
 */

export function logTurnTiming(
  stage: string,
  milliseconds: number,
  detail: Record<string, unknown> = {},
): void {
  console.info(JSON.stringify({
    code: "AGENT_TURN_TIMING",
    ms: Math.round(milliseconds),
    stage,
    ...detail,
  }));
}

export async function timed<T>(
  stage: string,
  run: () => Promise<T> | T,
  detail: Record<string, unknown> = {},
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await run();
  } finally {
    logTurnTiming(stage, performance.now() - startedAt, detail);
  }
}
