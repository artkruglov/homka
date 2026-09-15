/**
 * Production agent sandbox configuration.
 *
 * Constructs:
 * - Real Linux Bash in isolated runner containers with scoped persistent workspaces.
 * - Persistent personal/family tools and fail-closed external-group restrictions.
 */
import { defineSandbox } from "eve/sandbox";

import { scopedWorkspaceRunner } from "./lib/sandbox-runner/runner-sandbox-backend.js";
import { accessForMounts, sandboxHome } from "./lib/sandbox-runner/runner-sandbox-profile.js";
import { isMemoryReviewSession } from "./lib/memory-review/memory-review-session.js";
import { sandboxSessionId } from "./lib/sessions/session-context.js";
import { requireWorkspaceAuthorization } from "./lib/workspaces/workspace-context.js";
import { workspaceRepository } from "./lib/workspaces/workspace-repository.js";

export default defineSandbox({
  backend: scopedWorkspaceRunner(),
  async onSession({ ctx, use }) {
    const sessionId = sandboxSessionId(ctx);
    if (isMemoryReviewSession(ctx)) {
      // Silent review has no file tools or skills. Keep a durable Eve sandbox state without
      // materializing any workspace capability in the isolated runner.
      await use({ mounts: [], sandboxSessionId: sessionId });
      return;
    }

    const mounts = await workspaceRepository.mounts(requireWorkspaceAuthorization(ctx));
    const sandbox = await use({ mounts, sandboxSessionId: sessionId });
    // This exact package existed before custom group skills were removed. Trusted HOME is a
    // persistent workspace volume, so a new session must clean it even when no legacy Eve skill
    // manifest exists. The authored sandbox revision also reruns this hook for resumed sessions.
    await sandbox.removePath({
      force: true,
      path: `${sandboxHome(accessForMounts(mounts), mounts)}/.agents/skills/pohuy`,
      recursive: true,
    });
  },
});
