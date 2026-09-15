/**
 * Post-build Eve dynamic tool validation tests.
 *
 * Constructs covered:
 * - Exact step-scoped capabilities region is accepted.
 * - Bundler-generated aliases for `defineDynamic` preserve the same resolver contract.
 * - Missing, unterminated, and replay-prone resolver regions fail with a stable error code.
 */
import { describe, expect, it } from "vitest";

import { validateCompiledDynamicToolSurface } from "./validate-eve-tool-surface-build.js";

function compiled(event: "session.started" | "step.started" | "turn.started"): string {
  return [
    "prefix",
    "#region agent/tools/capabilities.ts",
    `defineDynamic({ events: { \"${event}\": async () => ({}) } });`,
    "//#endregion",
    "suffix",
  ].join("\n");
}

describe("compiled Eve dynamic tool surface", () => {
  it("accepts the step-scoped resolver", () => {
    expect(() => validateCompiledDynamicToolSurface(compiled("step.started"))).not.toThrow();
  });

  it("accepts a bundler-generated defineDynamic alias", () => {
    const aliasedResolver = compiled("step.started").replace("defineDynamic(", "defineDynamic$1(");

    expect(() => validateCompiledDynamicToolSurface(aliasedResolver)).not.toThrow();
  });

  it.each(["session.started", "turn.started"] as const)(
    "rejects the replay-prone %s resolver",
    (event) => {
      expect(() => validateCompiledDynamicToolSurface(compiled(event))).toThrow(
        "AGENT_EVE_DYNAMIC_TOOL_BUILD_INVALID",
      );
    },
  );

  it("rejects a stray step marker beside an incorrect resolver key", () => {
    const incorrectResolver = [
      "prefix",
      "#region agent/tools/capabilities.ts",
      `const marker = '"step.started"';`,
      `defineDynamic({ events: { "message.created": async () => ({}) } });`,
      "//#endregion",
      "suffix",
    ].join("\n");

    expect(() => validateCompiledDynamicToolSurface(incorrectResolver)).toThrow(
      "AGENT_EVE_DYNAMIC_TOOL_BUILD_INVALID",
    );
  });

  it("rejects absent and unterminated capabilities regions", () => {
    expect(() => validateCompiledDynamicToolSurface("no capabilities"))
      .toThrow("AGENT_EVE_DYNAMIC_TOOL_BUILD_INVALID");
    expect(() => validateCompiledDynamicToolSurface(CAPABILITIES_REGION_FIXTURE))
      .toThrow("AGENT_EVE_DYNAMIC_TOOL_BUILD_INVALID");
  });
});

const CAPABILITIES_REGION_FIXTURE = "#region agent/tools/capabilities.ts\nstep.started";
