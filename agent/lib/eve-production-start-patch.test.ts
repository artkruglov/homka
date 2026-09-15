/**
 * Eve production startup patch contract tests.
 *
 * Constructs covered:
 * - Patched Eve health timeout: permits bounded first-start sandbox initialization.
 * - Patch source: pins the reviewed timeout and exact Eve runtime artifact.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const PATCHED_HEALTH_TIMEOUT_MARKER = "const HEALTH_TIMEOUT_MS=3e5";

describe("Eve production startup patch", () => {
  it("allows five minutes for the built server to become healthy", async () => {
    const [evePackageSource, patchSource, runtime] = await Promise.all([
      readFile("node_modules/eve/package.json", "utf8"),
      readFile("scripts/apply-eve-patches.ts", "utf8"),
      readFile(
        "node_modules/eve/dist/src/internal/nitro/host/start-production-server.js",
        "utf8",
      ),
    ]);
    const evePackage = JSON.parse(evePackageSource) as { version?: string };

    expect(evePackage.version).toBe("0.40.0");
    expect(patchSource).toContain("const EVE_PRODUCTION_START_HEALTH_TIMEOUT_MS = 300_000;");
    expect(runtime).toContain(PATCHED_HEALTH_TIMEOUT_MARKER);
    expect(runtime).not.toContain("const HEALTH_TIMEOUT_MS=6e4");
  });
});
