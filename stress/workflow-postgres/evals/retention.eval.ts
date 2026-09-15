/**
 * PostgreSQL Workflow 300-turn stress gate.
 *
 * Gates:
 * - Every sequential turn completes on one durable Eve session.
 * - Exactly one non-idempotent side effect is observed per turn.
 * - Workflow event growth stays below the configured runtime event ceiling.
 * - Tail latency remains bounded relative to the warm beginning of the run.
 */
import pg from "pg";
import { defineEval } from "eve/evals";

const { Client } = pg;
const STRESS_TURN_COUNT = 300;
const LATENCY_WINDOW_TURNS = 25;
const MAX_P95_TURN_LATENCY_MS = 15_000;
const MAX_TAIL_TO_HEAD_LATENCY_RATIO = 5;
const MAX_WORKFLOW_EVENT_COUNT = 25_000;
const STRESS_EVAL_TIMEOUT_MS = 2_400_000;

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? Number.POSITIVE_INFINITY;
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export default defineEval({
  description: "Proves bounded 300-turn replay and exactly-once fixture side effects.",
  timeoutMs: STRESS_EVAL_TIMEOUT_MS,
  async test(t) {
    const connectionString = process.env.WORKFLOW_POSTGRES_URL;
    if (!connectionString) {
      throw new Error(
        "AGENT_WORKFLOW_STRESS_DATABASE_CONFIG_MISSING: Не задано подключение к тестовой базе Workflow",
      );
    }
    const client = new Client({ connectionString });
    await client.connect();
    try {
      // The side-effect ledger is intentionally outside Workflow schemas and starts empty each run.
      await client.query("DROP TABLE IF EXISTS workflow_stress_side_effects");
      await client.query(`CREATE TABLE workflow_stress_side_effects (
        ordinal integer PRIMARY KEY,
        recorded_at timestamptz NOT NULL DEFAULT now()
      )`);

      const latencies: number[] = [];
      for (let ordinal = 1; ordinal <= STRESS_TURN_COUNT; ordinal += 1) {
        const startedAt = performance.now();
        await t.send(`stress-turn-${ordinal}`, { turnPolicy: "queue" });
        latencies.push(performance.now() - startedAt);
        if (ordinal % LATENCY_WINDOW_TURNS === 0) {
          t.log(
            `progress=${ordinal}/${STRESS_TURN_COUNT} lastMs=${latencies.at(-1)?.toFixed(1)}`,
          );
        }
      }
      t.succeeded();

      // Public world tables provide the durable run metrics; the fixture ledger detects replayed tools.
      const metrics = await client.query<{
        side_effect_count: string;
        workflow_event_count: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM workflow_stress_side_effects) AS side_effect_count,
           (SELECT count(*)::text FROM workflow.workflow_events WHERE run_id = $1) AS workflow_event_count`,
        [t.sessionId],
      );
      const sideEffectCount = Number(metrics.rows[0]?.side_effect_count);
      const workflowEventCount = Number(metrics.rows[0]?.workflow_event_count);
      if (sideEffectCount !== STRESS_TURN_COUNT) {
        throw new Error(
          `AGENT_WORKFLOW_STRESS_SIDE_EFFECT_COUNT_INVALID: Ожидалось ${STRESS_TURN_COUNT} side effects, получено ${sideEffectCount}`,
        );
      }
      if (!Number.isInteger(workflowEventCount) || workflowEventCount >= MAX_WORKFLOW_EVENT_COUNT) {
        throw new Error(
          `AGENT_WORKFLOW_STRESS_EVENT_COUNT_INVALID: Workflow сохранил ${workflowEventCount} events при лимите ${MAX_WORKFLOW_EVENT_COUNT}`,
        );
      }

      // Compare warm head and tail windows so a hidden replay-growth regression fails deterministically.
      const p95LatencyMs = percentile(latencies, 0.95);
      const headAverageMs = average(latencies.slice(0, LATENCY_WINDOW_TURNS));
      const tailAverageMs = average(latencies.slice(-LATENCY_WINDOW_TURNS));
      const latencyRatio = tailAverageMs / Math.max(headAverageMs, 1);
      if (p95LatencyMs > MAX_P95_TURN_LATENCY_MS || latencyRatio > MAX_TAIL_TO_HEAD_LATENCY_RATIO) {
        throw new Error(
          `AGENT_WORKFLOW_STRESS_LATENCY_UNBOUNDED: p95=${p95LatencyMs.toFixed(1)}ms, tail/head=${latencyRatio.toFixed(2)}`,
        );
      }
      t.log(
        `turns=${STRESS_TURN_COUNT} events=${workflowEventCount} p95Ms=${p95LatencyMs.toFixed(1)} tailHead=${latencyRatio.toFixed(2)}`,
      );
    } finally {
      await client.query("DROP TABLE IF EXISTS workflow_stress_side_effects");
      await client.end();
    }
  },
});
