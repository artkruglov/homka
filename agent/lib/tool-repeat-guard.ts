/**
 * Per-turn guard against repeating a tool call that already failed with the same arguments.
 *
 * Exports:
 * - `TOOL_REPEAT_WITHOUT_PROGRESS_CODE`: the stable error code the model sees.
 * - `toolCallFingerprint`: tool name plus a key-sorted JSON of the input.
 * - `createToolRepeatGuard`: bounded in-memory registry of failed fingerprints per turn.
 * - `toolRepeatGuard`: the process-wide instance used by the model-facing boundary.
 *
 * Key construct:
 * - A retry counter cannot see a loop; the fingerprint of "tool + arguments" can. A model that
 *   repeats the exact call after a failure learns nothing new, and one such loop ran a family
 *   member's turn to the 32-step limit. The second identical call is refused before it executes,
 *   with the correction to change the call or report to the person.
 */
import { createHash } from "node:crypto";

export const TOOL_REPEAT_WITHOUT_PROGRESS_CODE = "AGENT_TOOL_REPEAT_WITHOUT_PROGRESS";

const MAX_TRACKED_TURNS = 500;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function toolCallFingerprint(toolName: string, input: unknown): string {
  return createHash("sha256").update(`${toolName}\n${stableJson(input)}`).digest("hex");
}

export interface ToolRepeatGuard {
  forget(turnKey: string): void;
  recordFailure(turnKey: string, fingerprint: string): void;
  recordSuccess(turnKey: string, fingerprint: string): void;
  refuses(turnKey: string, fingerprint: string): boolean;
}

export function createToolRepeatGuard(maxTurns = MAX_TRACKED_TURNS): ToolRepeatGuard {
  const failed = new Map<string, Set<string>>();
  const turnFailures = (turnKey: string): Set<string> => {
    const existing = failed.get(turnKey);
    if (existing) return existing;
    const created = new Set<string>();
    failed.set(turnKey, created);
    // Turns finish without a hook here, so the oldest tracked turns are dropped by insertion order.
    while (failed.size > maxTurns) {
      const oldest = failed.keys().next().value;
      if (oldest === undefined) break;
      failed.delete(oldest);
    }
    return created;
  };

  return {
    forget(turnKey) {
      failed.delete(turnKey);
    },
    recordFailure(turnKey, fingerprint) {
      turnFailures(turnKey).add(fingerprint);
    },
    recordSuccess(turnKey, fingerprint) {
      failed.get(turnKey)?.delete(fingerprint);
    },
    refuses(turnKey, fingerprint) {
      return failed.get(turnKey)?.has(fingerprint) ?? false;
    },
  };
}

export const toolRepeatGuard = createToolRepeatGuard();
