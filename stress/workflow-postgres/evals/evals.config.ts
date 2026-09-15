/**
 * Deterministic Workflow stress eval configuration.
 *
 * Export:
 * - Uses no judge or reporter; every gate is local and deterministic.
 */
import { defineEvalConfig } from "eve/evals";

export default defineEvalConfig({
  maxConcurrency: 1,
  timeoutMs: 2_400_000,
});
