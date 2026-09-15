/**
 * Durable per-call model usage.
 *
 * Export:
 * - `modelUsageRepository`: records provider usage, summarises a window, purges old rows.
 * - `recordModelUsage`: fire-and-forget writer for the production transport.
 *
 * Key constructs:
 * - Written from the transport, the only place that sees DeepSeek's cache split. The row has no
 *   session or family: a call is billed whether or not a turn owns it, and one installation serves
 *   one family (as the ingress counters in the digest already assume).
 * - A failed write is logged and dropped: spend accounting must never fail a model call.
 */
import { MODEL_USAGE_PURGE_BATCH_SIZE, MODEL_USAGE_RETENTION_DAYS } from "../../config.js";
import { database } from "../database.js";
import { modelCallCostUsd, type ModelSpendSummary } from "./model-spend.js";

export interface ModelUsageRecord {
  readonly cacheHitTokens: number;
  readonly cacheMissTokens: number;
  readonly modelId: string;
  readonly outputTokens: number;
  readonly webSearchCalls: number;
}

export const modelUsageRepository = {
  async record(usage: ModelUsageRecord, at: Date): Promise<void> {
    await database().query(
      `INSERT INTO model_usage_events
         (model_id, cache_hit_tokens, cache_miss_tokens, output_tokens, web_search_calls, cost_usd, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [usage.modelId, usage.cacheHitTokens, usage.cacheMissTokens, usage.outputTokens, usage.webSearchCalls,
        modelCallCostUsd(usage.modelId, usage, at), at],
    );
  },

  async summary(windowStart: Date, now: Date): Promise<ModelSpendSummary> {
    const result = await database().query<{
      cache_hit: string; cache_miss: string; calls: string; cost: string; output: string; unpriced: string; searches: string;
    }>(
      `SELECT count(*)::text AS calls,
              COALESCE(sum(cache_hit_tokens), 0)::text AS cache_hit,
              COALESCE(sum(cache_miss_tokens), 0)::text AS cache_miss,
              COALESCE(sum(output_tokens), 0)::text AS output,
              COALESCE(sum(web_search_calls), 0)::text AS searches,
              COALESCE(sum(cost_usd), 0)::text AS cost,
              count(*) FILTER (WHERE cost_usd IS NULL)::text AS unpriced
         FROM model_usage_events
        WHERE created_at >= $1 AND created_at <= $2`,
      [windowStart, now],
    );
    const row = result.rows[0]!;
    return {
      cacheHitTokens: Number(row.cache_hit),
      cacheMissTokens: Number(row.cache_miss),
      calls: Number(row.calls),
      costUsd: Number(row.cost),
      outputTokens: Number(row.output),
      unpricedCalls: Number(row.unpriced),
      webSearchCalls: Number(row.searches),
    };
  },

  async purgeExpired(now: Date): Promise<number> {
    const result = await database().query(
      `WITH expired AS (
         SELECT id FROM model_usage_events
          WHERE created_at < $1::timestamptz - ($2::integer * interval '1 day')
          ORDER BY created_at LIMIT $3::integer
          FOR UPDATE SKIP LOCKED
       )
       DELETE FROM model_usage_events event USING expired WHERE event.id = expired.id`,
      [now, MODEL_USAGE_RETENTION_DAYS, MODEL_USAGE_PURGE_BATCH_SIZE],
    );
    return result.rowCount ?? 0;
  },
};

export function recordModelUsage(usage: ModelUsageRecord): void {
  void modelUsageRepository.record(usage, new Date()).catch((error: unknown) => {
    console.error(JSON.stringify({
      code: "AGENT_MODEL_USAGE_RECORD_FAILED",
      error: error instanceof Error ? error.message : String(error),
      modelId: usage.modelId,
    }));
  });
}

export function purgeExpiredModelUsage(now: Date): Promise<number> {
  return modelUsageRepository.purgeExpired(now);
}
