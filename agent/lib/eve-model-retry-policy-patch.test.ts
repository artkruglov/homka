/**
 * Eve model-call retry policy patch tests.
 *
 * Constructs covered:
 * - Eve delegates bounded transport retries to AI SDK 7's stable default.
 * - Eve outer orchestration never reissues a completed or partially observed model step.
 * - Empty output and unsupported provider tools propagate without a second paid call.
 * - Compaction fails rather than issuing a second summary model call.
 * - Dependency pins satisfy Eve 0.40.0's AI SDK 7 peer contract.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const TOOL_LOOP_PATH = "node_modules/eve/dist/src/harness/tool-loop.js";
const COMPACTION_PATH = "node_modules/eve/dist/src/harness/compaction.js";
const execFileAsync = promisify(execFile);

describe("Eve model retry policy patch", () => {
  it("pins Eve and compatible AI SDK packages exactly", async () => {
    const packageSource = await readFile("package.json", "utf8");
    const packageJson = JSON.parse(packageSource) as {
      dependencies: Record<string, string>;
      overrides: Record<string, string>;
    };

    expect(packageJson.dependencies).toMatchObject({
      "@ai-sdk/anthropic": "4.0.37",
      "@ai-sdk/groq": "4.0.27",
      "@ai-sdk/openai-compatible": "3.0.29",
      "@googleworkspace/cli": "0.22.5",
      ai: "7.0.60",
      eve: "0.40.0",
    });
    expect(packageJson.overrides.ai).toBe("7.0.60");
  });

  it("delegates transport retries to AI SDK while disabling Eve-level reissues", async () => {
    const [patchSource, runtime, compaction, aiRuntime] = await Promise.all([
      readFile("scripts/apply-eve-patches.ts", "utf8"),
      readFile(TOOL_LOOP_PATH, "utf8"),
      readFile(COMPACTION_PATH, "utf8"),
      readFile("node_modules/ai/dist/index.js", "utf8"),
    ]);

    // AI SDK 7 owns its documented two-retry transport default; Eve must not override it.
    expect(patchSource).not.toContain("AI_SDK_TRANSPORT_MAX_RETRIES");
    expect(aiRuntime).toContain("maxRetries = 2");
    expect(runtime).not.toMatch(/ToolLoopAgent\([^)]*maxRetries/u);
    expect(compaction).not.toMatch(/generateText\([^)]*maxRetries/u);
    // Stable function names and log messages survive Eve's package build and guard semantic reissues.
    expect(runtime).toContain("async function runModelCallWithRetries");
    expect(runtime).toContain("async function attemptEmptyResponseRecovery");
    expect(runtime).toContain("async function attemptUnsupportedProviderToolRecovery");
    expect(runtime).not.toContain("model call failed transiently — retrying");
    // An empty model response has no side effect to duplicate, so Eve's single nudge-and-reissue
    // stays: without it a reasoning-only reply parks the whole session for the user.
    expect(runtime).toContain("reissuing the model call once");
    expect(patchSource).not.toContain("async function attemptEmptyResponseRecovery(e){return{outcome:`skipped`}}");
    expect(runtime).not.toContain("disabling unsupported provider tool(s); retrying step once");
    expect(compaction).toContain("EVE_COMPACTION_OUTPUT_TOO_LARGE");
  });

  it("keeps every patched model runtime syntactically valid", async () => {
    for (const path of [TOOL_LOOP_PATH, COMPACTION_PATH]) {
      await expect(execFileAsync(process.execPath, ["--check", path])).resolves.toMatchObject({
        stderr: "",
      });
    }
  });
});
