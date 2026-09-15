/**
 * Vitest project configuration.
 *
 * Constructs:
 * - Parallel local unit execution when database integration tests are disabled.
 * - Sequential integration execution when files share one disposable PostgreSQL database.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Historical migration tests create and verify many PostgreSQL objects. Keep a bounded
    // integration budget that also works on the small Docker runtime used for release checks.
    testTimeout: process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? 30_000 : 5_000,
    fileParallelism: process.env.RUN_DATABASE_INTEGRATION_TESTS !== "true",
  },
});
