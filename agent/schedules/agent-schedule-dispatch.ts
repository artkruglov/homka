/**
 * Eve static minute dispatcher for application-managed scheduled agent runs.
 *
 * Export:
 * - Default minute schedule that claims due user-defined scenarios and starts Telegram sessions.
 */
import { defineSchedule } from "eve/schedules";

import { dispatchDueAgentSchedules } from "../lib/agent-schedules/agent-schedule-dispatcher.js";

export default defineSchedule({
  cron: "* * * * *",
  run({ to, waitUntil }) {
    // Keep the cron task alive while Eve's channel source starts every claimed session.
    waitUntil(dispatchDueAgentSchedules(to));
  },
});
