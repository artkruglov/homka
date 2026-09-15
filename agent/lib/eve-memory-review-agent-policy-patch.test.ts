/**
 * Eve implicit-agent policy patch tests for restricted runtime modes.
 *
 * Constructs covered:
 * - The patched runtime removes Eve's implicit root `agent` from external groups and background review.
 * - Trusted interactive root sessions retain native delegation.
 * - Authored tools and non-root subagent lookalikes are never removed by the policy.
 * - The reproducible installer owns the exact Eve 0.40.0 runtime patch.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const TOOL_LOOP_PATH = "node_modules/eve/dist/src/harness/tool-loop.js";
const AUTH_KEY = Symbol("eve.auth.test");

interface RuntimeTool {
  readonly name: string;
  readonly runtimeAction?: {
    readonly kind: "remote-agent-call" | "subagent-call";
    readonly nodeId: string;
    readonly subagentName: string;
  };
}

interface RuntimeAuth {
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly authenticator: string;
}

type RuntimeToolBuilder = (
  tools: ReadonlyMap<string, RuntimeTool>,
  context: { get(key: symbol): RuntimeAuth | undefined },
) => Map<string, RuntimeTool>;

const implicitRootAgent: RuntimeTool = {
  name: "agent",
  runtimeAction: {
    kind: "subagent-call",
    nodeId: "__root__",
    subagentName: "agent",
  },
};

function extractRuntimeToolBuilder(source: string): RuntimeToolBuilder {
  const definition = source.match(
    /function buildHarnessToolsWithDynamicSubagents\(e,t\)\{[\s\S]*?return n\}/u,
  )?.[0];
  if (!definition) {
    throw new Error(
      "AGENT_EVE_MEMORY_REVIEW_PATCH_INVALID: Не найдена функция сборки runtime tools Eve",
    );
  }

  // Execute the installed function with inert dynamic subagents so this test proves behavior,
  // rather than merely asserting that a patch marker exists in a minified artifact.
  const factory = new Function(
    "buildDynamicSubagentTools",
    "AuthKey",
    `"use strict";${definition};return buildHarnessToolsWithDynamicSubagents;`,
  ) as (buildDynamicSubagentTools: () => never[], authKey: symbol) => RuntimeToolBuilder;
  return factory(() => [], AUTH_KEY);
}

function context(authenticator: string, attributes: Readonly<Record<string, unknown>> = {}) {
  const auth: RuntimeAuth = {
    attributes,
    authenticator,
  };
  return {
    get(key: symbol) {
      return key === AUTH_KEY ? auth : undefined;
    },
  };
}

describe("Eve implicit agent policy patch", () => {
  it("removes native root delegation only from verified background review", async () => {
    const runtime = await readFile(TOOL_LOOP_PATH, "utf8");
    const buildTools = extractRuntimeToolBuilder(runtime);

    const tools = buildTools(
      new Map([
        ["agent", implicitRootAgent],
        ["remember", { name: "remember" }],
      ]),
      context("memory-review", { memoryReviewMode: "background" }),
    );

    expect([...tools.keys()]).toEqual(["remember"]);
  });

  it("removes native root delegation from an authenticated external group", async () => {
    const runtime = await readFile(TOOL_LOOP_PATH, "utf8");
    const buildTools = extractRuntimeToolBuilder(runtime);

    const tools = buildTools(
      new Map([
        ["agent", implicitRootAgent],
        ["read_file", { name: "read_file" }],
      ]),
      context("telegram", { groupType: "external" }),
    );

    expect([...tools.keys()]).toEqual(["read_file"]);
  });

  it.each([
    ["private root session", "telegram", {}],
    ["family root session", "telegram", { groupType: "family_private" }],
    ["interactive review marker", "memory-review", { memoryReviewMode: "interactive" }],
    ["unverified background marker", "telegram", { memoryReviewMode: "background" }],
  ])("retains native root delegation for %s", async (_case, authenticator, attributes) => {
    const runtime = await readFile(TOOL_LOOP_PATH, "utf8");
    const buildTools = extractRuntimeToolBuilder(runtime);

    const tools = buildTools(
      new Map([["agent", implicitRootAgent]]),
      context(authenticator, attributes),
    );

    expect(tools.get("agent")).toBe(implicitRootAgent);
  });

  it.each([
    ["authored tool", { name: "agent" }],
    ["non-root subagent", {
      name: "agent",
      runtimeAction: {
        kind: "subagent-call" as const,
        nodeId: "review-specialist",
        subagentName: "agent",
      },
    }],
  ])("does not remove an %s lookalike", async (_case, agentTool) => {
    const runtime = await readFile(TOOL_LOOP_PATH, "utf8");
    const buildTools = extractRuntimeToolBuilder(runtime);

    const tools = buildTools(
      new Map([["agent", agentTool]]),
      context("memory-review", { memoryReviewMode: "background" }),
    );

    expect(tools.get("agent")).toBe(agentTool);
  });

  it("keeps the policy in the reproducible Eve patch installer", async () => {
    const [patchSource, runtime] = await Promise.all([
      readFile("scripts/apply-eve-patches.ts", "utf8"),
      readFile(TOOL_LOOP_PATH, "utf8"),
    ]);

    expect(patchSource).toContain("memoryReviewMode===`background`");
    expect(patchSource).toContain("groupType===`external`");
    expect(runtime.match(/memoryReviewMode===`background`/gu)).toHaveLength(1);
    expect(runtime.match(/groupType===`external`/gu)).toHaveLength(1);
  });
});
