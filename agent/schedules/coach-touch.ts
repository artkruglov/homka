/**
 * Eve ten-minute tick for the coach.
 *
 * Export:
 * - Default schedule; the dispatcher decides whether anyone has a reason for a question now.
 */
import { defineSchedule } from "eve/schedules";

import { dispatchCoachTouches } from "../lib/initiative/coach-runner.js";

export default defineSchedule({
  cron: "5-59/10 * * * *",
  run({ waitUntil }) {
    waitUntil(dispatchCoachTouches().catch((error: unknown) => {
      console.error(JSON.stringify({
        code: "AGENT_COACH_SCHEDULE_FAILED",
        errorMessage: error instanceof Error ? error.message : String(error),
      }));
      throw error;
    }));
  },
});
