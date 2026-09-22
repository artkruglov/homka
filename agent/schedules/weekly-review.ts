/**
 * Eve ten-minute tick for the weekly review.
 *
 * Export:
 * - Default schedule; the dispatcher decides whose Sunday evening it is right now.
 *
 * The minute is offset from the coach tick so the two do not read the same tables at once.
 */
import { defineSchedule } from "eve/schedules";

import { dispatchWeeklyReviews } from "../lib/initiative/weekly-review-runner.js";

export default defineSchedule({
  cron: "7-59/10 * * * *",
  run({ waitUntil }) {
    waitUntil(dispatchWeeklyReviews().catch((error: unknown) => {
      console.error(JSON.stringify({
        code: "AGENT_WEEKLY_REVIEW_SCHEDULE_FAILED",
        errorMessage: error instanceof Error ? error.message : String(error),
      }));
      throw error;
    }));
  },
});
