/**
 * External group file removal contract tests.
 *
 * Constructs covered:
 * - Invalid relative paths fail before Eve requests destructive approval.
 * - A valid scope-relative path remains confirmation-gated.
 */
import { describe, expect, it } from "vitest";

import { removeGroupFileTool } from "./workspaces/remove-group-file-tool.js";

describe("remove_group_file approval", () => {
  it("rejects traversal before requesting approval", () => {
    expect(() => (removeGroupFileTool.approval as (context: never) => unknown)({
      toolInput: { path: "../family/private.md" },
    } as never)).toThrowError(/AGENT_WORKSPACE_PATH_INVALID/u);
  });

  it("requires approval for a valid group-relative path", () => {
    expect((removeGroupFileTool.approval as (context: never) => unknown)({
      toolInput: { path: "reports/result.md" },
    } as never)).toBe("user-approval");
  });
});
