/**
 * Per-step model usage audit log.
 *
 * Export:
 * - Eve hook that logs framework-reported usage of every completed model step with session identity,
 *   plus `AGENT_TURN_TIMING` markers at turn and step start.
 *
 * Key construct:
 * - Provider cache fields are logged separately at the transport boundary (`AGENT_MODEL_USAGE`);
 *   this hook adds the session, turn, and step so both logs can be correlated by order and time.
 */
import { defineHook } from "eve/hooks";

import { formatStepUsageLog } from "../lib/model-usage-log.js";
import { logTurnTiming } from "../lib/turn-timing.js";

export default defineHook({
  events: {
    // Wall-clock markers between the prepared inbound context and the first model request.
    "turn.started"(event, ctx) {
      logTurnTiming("turn_started", 0, {
        channelKind: ctx.channel.kind,
        sessionId: ctx.session.id,
        turnId: event.data.turnId,
      });
    },
    "step.started"(event, ctx) {
      logTurnTiming("step_started", 0, {
        sessionId: ctx.session.id,
        stepIndex: event.data.stepIndex,
        turnId: event.data.turnId,
      });
    },
    "step.completed"(event, ctx) {
      console.info(formatStepUsageLog(event, {
        channelKind: ctx.channel.kind,
        sessionId: ctx.session.id,
      }));
    },
  },
});
