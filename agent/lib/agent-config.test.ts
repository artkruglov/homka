/**
 * Root Eve agent configuration tests.
 *
 * Constructs:
 * - Eve's implicit native agent tool is available only on the root runtime node.
 * - Root configuration does not use the removed delegation-depth limit.
 */
import { describe, expect, it } from "vitest";
import agent from "../agent.js";
import { isImplicitAgentToolAvailable } from "../../node_modules/eve/dist/src/runtime/framework-tools/agent.js";
import { ROOT_RUNTIME_AGENT_NODE_ID } from "../../node_modules/eve/dist/src/runtime/graph.js";

describe("root agent configuration", () => {
  it("relies on Eve's root-only native agent tool", () => {
    expect("limits" in agent).toBe(false);
    expect(isImplicitAgentToolAvailable({
      disabledFrameworkTools: [],
      hasAuthoredAgentTool: false,
      nodeId: ROOT_RUNTIME_AGENT_NODE_ID,
    })).toBe(true);
    expect(isImplicitAgentToolAvailable({
      disabledFrameworkTools: [],
      hasAuthoredAgentTool: false,
      nodeId: "declared-child",
    })).toBe(false);
  });
});
