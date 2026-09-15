/**
 * Turn-scoped trusted delegation role instructions.
 *
 * Export:
 * - Trusted interactive root conversations receive orchestration rules.
 * - External, scheduled, memory-review, and child turns receive no delegation guidance.
 */
import { defineDynamic, defineInstructions } from "eve/instructions";

import { ORCHESTRATOR_DELEGATION_RULES } from "../lib/prompt/delegation-fragments.js";
import { isScheduledSession } from "../lib/agent-schedules/scheduled-session.js";
import { isMemoryReviewSession } from "../lib/memory-review/memory-review-session.js";

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => {
      const externalGroup = ctx.session.auth.current?.attributes.groupType === "external";
      if (
        externalGroup ||
        ctx.channel.kind === "subagent" ||
        isScheduledSession(ctx) ||
        isMemoryReviewSession(ctx)
      ) {
        return null;
      }
      return defineInstructions({ markdown: ORCHESTRATOR_DELEGATION_RULES });
    },
  },
});
