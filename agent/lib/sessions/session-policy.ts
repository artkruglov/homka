/**
 * Durable session rotation policy.
 *
 * Exports:
 * - `SessionRotationState`: persisted fields used by the decision.
 * - `continuationTokenForGeneration`: preserves generation-zero compatibility.
 * - `sessionNeedsRotation`: applies inactivity, turn, manual, and pending-operation rules.
 *
 * Key construct:
 * - A private chat's canonical session ends after twelve quiet hours. It grew to 120k tokens of
 *   history that every morning question re-sent; memory, tasks and up to 99 recent timeline
 *   messages carry into the new session. Family and group sessions keep the 30-day rule: their
 *   live discussion matters more than the saving.
 */
import {
  SESSION_INACTIVITY_DAYS,
  SESSION_MAX_COMPLETED_TURNS,
  SESSION_PRIVATE_INACTIVITY_HOURS,
} from "../../config.js";

const MILLISECONDS_PER_HOUR = 60 * 60 * 1_000;
const MILLISECONDS_PER_DAY = 24 * MILLISECONDS_PER_HOUR;

export interface SessionRotationState {
  completedTurns: number;
  kind: "canonical" | "proactive" | "scheduled" | "task";
  lastActivityAt: Date;
  now: Date;
  pendingOperation: boolean;
  rotationRequestedAt: Date | null;
  scope: "family" | "group" | "personal";
}

export function continuationTokenForGeneration(baseToken: string, generation: number): string {
  // Generation zero deliberately retains Eve's old key so deploy does not reset live chats.
  return generation === 0 ? baseToken : `${baseToken}:osinara:${generation}`;
}

export function sessionNeedsRotation(state: SessionRotationState): boolean {
  // An approval or authorization must resume the exact session that requested it.
  if (state.pendingOperation) return false;

  const privateChat = state.scope === "personal" && state.kind === "canonical";
  const inactivityCutoff = state.now.getTime() - (privateChat
    ? SESSION_PRIVATE_INACTIVITY_HOURS * MILLISECONDS_PER_HOUR
    : SESSION_INACTIVITY_DAYS * MILLISECONDS_PER_DAY);
  return state.rotationRequestedAt !== null ||
    state.completedTurns >= SESSION_MAX_COMPLETED_TURNS ||
    state.lastActivityAt.getTime() <= inactivityCutoff;
}
