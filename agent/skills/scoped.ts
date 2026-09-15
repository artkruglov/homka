/**
 * Dynamic Eve skills resolved from the current trusted conversation policy.
 *
 * Export:
 * - Session-scoped trusted skill map; stable packages are uploaded once per session.
 */
import { defineDynamic } from "eve/skills";

import { isScheduledSession } from "../lib/agent-schedules/scheduled-session.js";
import { resolveTrustedSessionSkills } from "../lib/group-skills/group-skill-resolver.js";
import { isMemoryReviewSession } from "../lib/memory-review/memory-review-session.js";

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => isMemoryReviewSession(ctx)
      ? {}
      : resolveTrustedSessionSkills(ctx.session.auth, {
        scheduledRun: isScheduledSession(ctx),
        subagent: ctx.channel.kind === "subagent",
      }),
  },
});
