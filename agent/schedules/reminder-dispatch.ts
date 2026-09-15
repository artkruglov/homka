/**
 * Eve static minute dispatcher for application-managed proactive notifications.
 *
 * Export:
 * - Default minute schedule for reminders, expired-session retention, workspace cleanup,
 *   cancellation of Telegram approvals nobody confirmed in time, and physical cleanup of memory
 *   whose soft-delete recovery window has elapsed, and model usage rows past their retention.
 */
import { defineSchedule } from "eve/schedules";
import { dispatchErrands } from "../lib/errands/errand-dispatcher.js";

import { dispatchDueReminders } from "../lib/reminders/reminder-dispatcher.js";
import { purgeExpiredModelUsage } from "../lib/health/model-usage-repository.js";
import { purgeSoftDeletedMemory } from "../lib/memory-retention.js";
import { deleteExpiredSessions } from "../lib/sessions/session-retention.js";
import { sweepTimedOutApprovals } from "../lib/telegram-hitl/approval-timeout-sweep.js";
import { deleteOrphanedWorkspaces } from "../lib/workspaces/workspace-deletion.js";

export default defineSchedule({
  cron: "* * * * *",
  run({ waitUntil }) {
    waitUntil(Promise.all([
      dispatchDueReminders(),
      dispatchErrands(),
      deleteExpiredSessions(),
      deleteOrphanedWorkspaces(),
      sweepTimedOutApprovals(),
      purgeSoftDeletedMemory(new Date()),
      purgeExpiredModelUsage(new Date()),
    ]));
  },
});
