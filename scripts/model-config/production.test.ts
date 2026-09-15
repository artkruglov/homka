/**
 * Production model configuration dependency tests.
 *
 * Constructs covered:
 * - Canonical production paths, including the durable journal, are exact and immutable.
 * - Production operations fail before filesystem access when the caller is not root.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createProductionModelConfigDependencies,
  PRODUCTION_MODEL_CONFIG_PATHS,
} from "./production.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("production model configuration dependencies", () => {
  it("pins the exact host files and lock path", () => {
    expect(PRODUCTION_MODEL_CONFIG_PATHS).toEqual({
      configPath: "/opt/osinara/agent-model-providers.json",
      envPath: "/opt/osinara/.env",
      journalPath: "/opt/osinara/.model-config.transaction",
      lockPath: "/opt/osinara/.model-config.lock",
    });
    expect(Object.isFrozen(PRODUCTION_MODEL_CONFIG_PATHS)).toBe(true);
  });

  it("requires root before allowing controller filesystem operations", () => {
    vi.spyOn(process, "getuid").mockReturnValue(1000);
    vi.spyOn(process, "getgid").mockReturnValue(1000);
    const dependencies = createProductionModelConfigDependencies({
      health: vi.fn(),
      preflight: vi.fn(),
      restart: vi.fn(),
    });

    expect(() => dependencies.assertRoot()).toThrow("OSINARA_MODEL_CONFIG_ROOT_REQUIRED");
  });
});
