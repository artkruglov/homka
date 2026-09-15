/**
 * Bounded warm-cache reconciliation for disposable sandbox compute.
 *
 * Exports:
 * - `SandboxReconciliationResult`: stopped/removed counts for operational logging.
 * - `reconcileSandboxContainers`: stops idle compute and removes expired or excess warm entries.
 * - Warm retention constants: explicit resource bounds independent of environment variables.
 */
import type Docker from "dockerode";

import type { SandboxActivityRegistry } from "./docker-sandbox-lifecycle.js";

export const SANDBOX_STOPPED_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const SANDBOX_STOPPED_CACHE_MAX = 16;
const SANDBOX_STOP_TIMEOUT_SECONDS = 5;

const SANDBOX_SESSION_LABEL = "dev.osinara.sandbox.session-id";
const SANDBOX_PROJECT_LABEL = "dev.osinara.sandbox.project";

export interface SandboxReconciliationResult {
  removed: number;
  stopped: number;
}

interface StoppedContainer {
  container: Docker.Container;
  finishedAtMs: number;
  id: string;
  sessionId: string;
}

function requireFinishedAt(value: string | undefined, id: string): number {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    throw new Error(
      `AGENT_SANDBOX_RUNNER_STATE_INVALID: Stopped container ${id} has no completion time`,
    );
  }
  return timestamp;
}

export async function reconcileSandboxContainers(input: {
  activity: SandboxActivityRegistry;
  docker: Docker;
  idleCutoffMs: number;
  nowMs: number;
  project: string;
}): Promise<SandboxReconciliationResult> {
  const listed = await input.docker.listContainers({
    all: true,
    filters: {
      label: [SANDBOX_SESSION_LABEL, `${SANDBOX_PROJECT_LABEL}=${input.project}`],
    },
  });
  const running = listed.filter((item) => item.State === "running");
  const stopped = await Promise.all(listed.filter((item) => item.State !== "running").map(
    async (item): Promise<StoppedContainer | null> => {
      const sessionId = item.Labels[SANDBOX_SESSION_LABEL];
      if (typeof sessionId !== "string") return null;
      const container = input.docker.getContainer(item.Id);
      const inspection = await container.inspect();
      return {
        container,
        finishedAtMs: requireFinishedAt(inspection.State.FinishedAt, item.Id),
        id: item.Id,
        sessionId,
      };
    },
  ));
  const stoppedContainers = stopped.filter((item): item is StoppedContainer => item !== null)
    .sort((left, right) => left.finishedAtMs - right.finishedAtMs);
  const excess = Math.max(0, stoppedContainers.length - SANDBOX_STOPPED_CACHE_MAX);
  const retentionCutoffMs = input.nowMs - SANDBOX_STOPPED_RETENTION_MS;
  const removalIds = new Set(stoppedContainers
    .filter((item, index) => item.finishedAtMs <= retentionCutoffMs || index < excess)
    .map((item) => item.id));

  // Stop only through the activity gate so an arriving command cannot race the transition.
  const stopResults = await Promise.all(running.map(async (item) => {
    const sessionId = item.Labels[SANDBOX_SESSION_LABEL];
    if (typeof sessionId !== "string") return false;
    return await input.activity.removeIfIdle(sessionId, input.idleCutoffMs, async () => {
      await input.docker.getContainer(item.Id).stop({ t: SANDBOX_STOP_TIMEOUT_SECONDS });
    });
  }));

  // Recently stopped containers form the bounded warm cache; only expired or excess entries leave it.
  const removeResults = await Promise.all(stoppedContainers.map(async (item) => {
    if (!removalIds.has(item.id)) return false;
    return await input.activity.removeIfIdle(item.sessionId, input.idleCutoffMs, async () => {
      await item.container.remove({ force: true, v: true }).catch((error) => {
        const status = typeof error === "object" && error !== null && "statusCode" in error
          ? Number(error.statusCode)
          : undefined;
        if (status !== 404) throw error;
      });
    });
  }));
  return {
    removed: removeResults.filter(Boolean).length,
    stopped: stopResults.filter(Boolean).length,
  };
}
