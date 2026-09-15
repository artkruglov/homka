/**
 * Per-session guard against re-running a sandbox command that already timed out.
 *
 * Exports:
 * - `SANDBOX_REPEAT_REFUSED_EXIT_CODE`, `SANDBOX_REPEAT_REFUSED_MESSAGE`: what the model sees.
 * - `sandboxCommandFingerprint`: command plus working directory.
 * - `createSandboxRepeatGuard`: bounded, expiring registry of timed-out commands per session.
 *
 * Key construct:
 * - Eve's native `bash` bypasses the application tool boundary, so the runner is the only place
 *   that can see the loop: a browser `open` that timed out at 120 s was re-run three times in one
 *   turn, six minutes of waiting for the same result. An identical command within the expiry
 *   window is refused at once; a changed command, or the same one later, runs normally.
 */
import { createHash } from "node:crypto";

export const SANDBOX_REPEAT_REFUSED_EXIT_CODE = 125;
export const SANDBOX_REPEAT_REFUSED_MESSAGE =
  "AGENT_SANDBOX_RUNNER_REPEAT_WITHOUT_PROGRESS: Эта же команда уже превысила таймаут в этой сессии. " +
  "Не повторяйте её без изменений: смените команду или сайт, либо сообщите пользователю, что действие не удалось.";

const DEFAULT_EXPIRY_MS = 15 * 60 * 1_000;
const MAX_SESSIONS = 500;
const MAX_FINGERPRINTS_PER_SESSION = 50;

export function sandboxCommandFingerprint(command: string, workingDirectory?: string): string {
  return createHash("sha256").update(`${workingDirectory ?? ""}\n${command}`).digest("hex");
}

export interface SandboxRepeatGuard {
  forget(sessionId: string): void;
  recordTimeout(sessionId: string, fingerprint: string): void;
  refuses(sessionId: string, fingerprint: string): boolean;
}

export function createSandboxRepeatGuard(
  now: () => number,
  expiryMs = DEFAULT_EXPIRY_MS,
): SandboxRepeatGuard {
  const sessions = new Map<string, Map<string, number>>();

  return {
    forget(sessionId) {
      sessions.delete(sessionId);
    },
    recordTimeout(sessionId, fingerprint) {
      let timeouts = sessions.get(sessionId);
      if (!timeouts) {
        timeouts = new Map();
        sessions.set(sessionId, timeouts);
        while (sessions.size > MAX_SESSIONS) {
          const oldest = sessions.keys().next().value;
          if (oldest === undefined) break;
          sessions.delete(oldest);
        }
      }
      timeouts.delete(fingerprint);
      timeouts.set(fingerprint, now());
      while (timeouts.size > MAX_FINGERPRINTS_PER_SESSION) {
        const oldest = timeouts.keys().next().value;
        if (oldest === undefined) break;
        timeouts.delete(oldest);
      }
    },
    refuses(sessionId, fingerprint) {
      const recordedAt = sessions.get(sessionId)?.get(fingerprint);
      if (recordedAt === undefined) return false;
      if (now() - recordedAt > expiryMs) {
        sessions.get(sessionId)?.delete(fingerprint);
        return false;
      }
      return true;
    },
  };
}
