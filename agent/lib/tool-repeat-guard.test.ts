/**
 * Tool repeat guard tests.
 *
 * Constructs covered:
 * - The fingerprint ignores key order and undefined fields but not values.
 * - A failed fingerprint is refused in the same turn only; a success clears it; other turns and
 *   other arguments are unaffected; the registry stays bounded.
 * - Through the model-facing boundary the second identical call after a failure never reaches
 *   the tool and carries the stable correction code.
 */
import { defineTool, type ToolDefinition } from "eve/tools";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { wrapModelFacingTool } from "./model-facing-tool.js";
import {
  createToolRepeatGuard,
  TOOL_REPEAT_WITHOUT_PROGRESS_CODE,
  toolCallFingerprint,
} from "./tool-repeat-guard.js";

describe("toolCallFingerprint", () => {
  it("is stable across key order and undefined fields, and sensitive to values", () => {
    const base = toolCallFingerprint("web_fetch", { url: "https://a", timeout: 5 });
    expect(toolCallFingerprint("web_fetch", { timeout: 5, url: "https://a", extra: undefined })).toBe(base);
    expect(toolCallFingerprint("web_fetch", { url: "https://b", timeout: 5 })).not.toBe(base);
    expect(toolCallFingerprint("web_search", { url: "https://a", timeout: 5 })).not.toBe(base);
  });
});

describe("createToolRepeatGuard", () => {
  it("refuses a failed fingerprint within its turn until it succeeds", () => {
    const guard = createToolRepeatGuard();
    guard.recordFailure("s:t1", "f");
    expect(guard.refuses("s:t1", "f")).toBe(true);
    expect(guard.refuses("s:t1", "g")).toBe(false);
    expect(guard.refuses("s:t2", "f")).toBe(false);
    guard.recordSuccess("s:t1", "f");
    expect(guard.refuses("s:t1", "f")).toBe(false);
  });

  it("drops the oldest turns beyond the bound", () => {
    const guard = createToolRepeatGuard(2);
    guard.recordFailure("s:t1", "f");
    guard.recordFailure("s:t2", "f");
    guard.recordFailure("s:t3", "f");
    expect(guard.refuses("s:t1", "f")).toBe(false);
    expect(guard.refuses("s:t3", "f")).toBe(true);
  });
});

describe("model-facing boundary repeat guard", () => {
  it("refuses the second identical call after a failure without executing it", async () => {
    const execute = vi.fn(async () => {
      throw new Error("AGENT_TOOL_DEPENDENCY_FAILED: upstream reset");
    });
    const wrapped = wrapModelFacingTool("web_fetch", defineTool({
      description: "Test tool",
      inputSchema: z.object({ url: z.string() }),
      execute,
    }) as ToolDefinition<any, any>);
    const ctx = { session: { id: "wrun_repeat", turn: { id: "turn_1" } } } as never;

    await expect(wrapped.execute({ url: "https://a" }, ctx)).rejects.toThrow("AGENT_TOOL_DEPENDENCY_FAILED");
    await expect(wrapped.execute({ url: "https://a" }, ctx)).rejects.toThrow(TOOL_REPEAT_WITHOUT_PROGRESS_CODE);
    expect(execute).toHaveBeenCalledTimes(1);

    // Different arguments, a different turn, and a context without a turn all still execute.
    await expect(wrapped.execute({ url: "https://b" }, ctx)).rejects.toThrow("AGENT_TOOL_DEPENDENCY_FAILED");
    const other = { session: { id: "wrun_repeat", turn: { id: "turn_2" } } } as never;
    await expect(wrapped.execute({ url: "https://a" }, other)).rejects.toThrow("AGENT_TOOL_DEPENDENCY_FAILED");
    await expect(wrapped.execute({ url: "https://a" }, {} as never)).rejects.toThrow("AGENT_TOOL_DEPENDENCY_FAILED");
    expect(execute).toHaveBeenCalledTimes(4);
  });
});
