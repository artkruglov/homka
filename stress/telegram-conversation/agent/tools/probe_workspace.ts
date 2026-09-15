/** Test-only tool: the current participant can use exactly the workspace of the current chat. */
import { defineTool } from "eve/tools";
import { z } from "zod";
import { requireWorkspaceAuthorization } from "../../../../agent/lib/workspaces/workspace-context.js";

export default defineTool({
  description: "Verify the current participant can use the workspace of this chat.",
  inputSchema: z.object({ marker: z.string() }),
  async execute({ marker }, ctx) {
    const auth = requireWorkspaceAuthorization(ctx);
    const scopes = ctx.session.auth.current?.attributes.memoryScopes;
    const expected = auth.telegramChatType === "private" ? ["personal", "family"] :
      auth.groupType === "family_private" ? ["family"] : ["group"];
    if (JSON.stringify(scopes) !== JSON.stringify(expected)) {
      throw new Error(`TEST_GROUP_AUTH_INVALID: ${JSON.stringify(scopes)} expected ${JSON.stringify(expected)}`);
    }
    const sandbox = await ctx.getSandbox();
    await sandbox.writeTextFile({ path: "/workspace/probe.txt", content: marker });
    return sandbox.readTextFile({ path: "/workspace/probe.txt" });
  },
});
