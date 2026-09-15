/** External capability-coupled skills refreshed from verified auth each turn. */
import { defineDynamic } from "eve/skills";

import { isScheduledSession } from "../lib/agent-schedules/scheduled-session.js";
import { resolveExternalTurnSkills } from "../lib/group-skills/group-skill-resolver.js";
import { isMemoryReviewSession } from "../lib/memory-review/memory-review-session.js";
import { timed } from "../lib/turn-timing.js";

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => isMemoryReviewSession(ctx)
      ? {}
      : timed("skills_external", () => resolveExternalTurnSkills(ctx.session.auth, {
        scheduledRun: isScheduledSession(ctx),
        subagent: ctx.channel.kind === "subagent",
      })),
  },
});
