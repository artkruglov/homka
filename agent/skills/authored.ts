/** Family-authored skills, refreshed from the library on every trusted turn. */
import { defineDynamic } from "eve/skills";

import { resolveAuthoredTurnSkills } from "../lib/authored-skills/authored-skill-resolver.js";
import { isMemoryReviewSession } from "../lib/memory-review/memory-review-session.js";
import { timed } from "../lib/turn-timing.js";

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => timed("skills_authored", () => resolveAuthoredTurnSkills(ctx.session.auth, {
      memoryReview: isMemoryReviewSession(ctx),
      subagent: ctx.channel.kind === "subagent",
    })),
  },
});
