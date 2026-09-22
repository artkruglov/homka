/**
 * Eve ten-minute tick for alerts about what waits for a person's answer.
 *
 * Export:
 * - Default schedule; the dispatcher decides whether anything is actually waiting.
 */
import { defineSchedule } from "eve/schedules";

import { dispatchPartnerAlerts } from "../lib/initiative/partner-alert-runner.js";

export default defineSchedule({
  cron: "3-59/10 * * * *",
  run({ waitUntil }) {
    waitUntil(dispatchPartnerAlerts().catch((error: unknown) => {
      console.error(JSON.stringify({
        code: "AGENT_PARTNER_ALERT_SCHEDULE_FAILED",
        errorMessage: error instanceof Error ? error.message : String(error),
      }));
      throw error;
    }));
  },
});
