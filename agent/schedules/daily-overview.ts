/**
 * Eve ten-minute tick for the morning overview.
 *
 * Export:
 * - Default schedule; the dispatcher decides whose morning it already is and whether to speak.
 */
import { defineSchedule } from "eve/schedules";

import { dispatchDailyOverviews } from "../lib/initiative/daily-overview-runner.js";

export default defineSchedule({
  cron: "*/10 * * * *",
  run({ waitUntil }) {
    waitUntil(dispatchDailyOverviews().catch((error: unknown) => {
      console.error(JSON.stringify({
        code: "AGENT_DAILY_OVERVIEW_SCHEDULE_FAILED",
        errorMessage: error instanceof Error ? error.message : String(error),
      }));
      throw error;
    }));
  },
});
