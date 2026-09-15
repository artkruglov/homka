/**
 * Canonical model-provider runtime limits.
 *
 * Exports:
 * - `MODEL_PROVIDER_MAX_OUTPUT_TOKENS`: highest output limit exercised by the runtime transports.
 */

/** Catalog metadata may advertise more, but the application only installs runtime-tested limits. */
export const MODEL_PROVIDER_MAX_OUTPUT_TOKENS = 128_000;
