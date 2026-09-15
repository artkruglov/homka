/**
 * Bounded Docker exec implementation for sandbox commands.
 *
 * Exports:
 * - `executeSandboxProcess`: runs one command, collects bounded output, and removes orphaned compute.
 * - `processTimedOut`: whether a result carries the runner's timeout marker.
 */
import { randomUUID } from "node:crypto";
import { PassThrough, type Duplex } from "node:stream";

import type Docker from "dockerode";

import {
  SANDBOX_RUNNER_MAX_OUTPUT_BYTES,
  SANDBOX_RUNNER_PROCESS_DEFAULT_TIMEOUT_MS,
  type SandboxRunnerProcessRequest,
  type SandboxRunnerProcessResponse,
} from "../../agent/lib/sandbox-runner/sandbox-runner-contract.js";
import { collectLimitedStream } from "./docker-sandbox-files.js";

const PROCESS_KILL_GRACE_SECONDS = 5;
export const PROCESS_TIMED_OUT_MARKER = "AGENT_SANDBOX_RUNNER_PROCESS_TIMED_OUT";

export function processTimedOut(result: Pick<SandboxRunnerProcessResponse, "stderr">): boolean {
  return result.stderr.includes(PROCESS_TIMED_OUT_MARKER);
}

async function removeOrphanedCompute(container: Docker.Container): Promise<void> {
  // Compute is disposable while named-volume workspaces survive recreation on the next command.
  try {
    await container.remove({ force: true, v: true });
  } catch (error) {
    throw new Error(
      "AGENT_SANDBOX_RUNNER_PROCESS_CLEANUP_FAILED: Unterminated process container could not be removed",
      { cause: error },
    );
  }
}

async function removeAfterPrimaryFailure(
  container: Docker.Container,
  primaryError: unknown,
): Promise<void> {
  try {
    await removeOrphanedCompute(container);
  } catch (cleanupError) {
    // Cleanup remains observable without replacing the actionable command or cancellation error.
    console.error("Sandbox process cleanup failed after primary error", {
      cleanupError,
      primaryError,
    });
  }
}

export async function executeSandboxProcess(
  docker: Docker,
  container: Docker.Container,
  request: SandboxRunnerProcessRequest,
  signal?: AbortSignal,
): Promise<SandboxRunnerProcessResponse> {
  const timeoutMs = request.timeoutMs ?? SANDBOX_RUNNER_PROCESS_DEFAULT_TIMEOUT_MS;
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1_000));
  const exec = await container.exec({
    AttachStderr: true,
    AttachStdout: true,
    // TERM lets cooperative children clean up; KILL guarantees the process group cannot outlive grace.
    Cmd: [
      "timeout",
      "--signal=TERM",
      `--kill-after=${PROCESS_KILL_GRACE_SECONDS}s`,
      String(timeoutSeconds),
      "bash",
      "-c",
      request.command,
    ],
    Env: request.environment
      ? Object.entries(request.environment).map(([name, value]) => `${name}=${value}`)
      : undefined,
    Tty: false,
    WorkingDir: request.workingDirectory ?? "/workspace",
  });
  const startedAt = Date.now();

  let stream: Duplex;
  try {
    // dockerode types the exec connection as a plain ReadWriteStream; it is a destroyable socket.
    stream = (await exec.start({ Tty: false, abortSignal: signal })) as Duplex;
  } catch (error) {
    await removeAfterPrimaryFailure(container, error);
    throw error;
  }

  // Docker multiplexes both output streams over one exec connection.
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  // Collectors propagate the primary error; these listeners absorb only follow-up demux writes.
  stdout.on("error", () => undefined);
  stderr.on("error", () => undefined);
  docker.modem.demuxStream(stream, stdout, stderr);
  stream.once("end", () => {
    stdout.end();
    stderr.end();
  });
  stream.once("error", (error) => {
    stdout.destroy(error);
    stderr.destroy(error);
  });

  let stdoutBytes: Buffer;
  let stderrBytes: Buffer;
  try {
    [stdoutBytes, stderrBytes] = await Promise.all([
      collectLimitedStream(stdout, SANDBOX_RUNNER_MAX_OUTPUT_BYTES),
      collectLimitedStream(stderr, SANDBOX_RUNNER_MAX_OUTPUT_BYTES),
    ]);
  } catch (error) {
    // Close every side before cleanup so neither demux nor the remaining collector can stay active.
    stream.destroy();
    stdout.destroy();
    stderr.destroy();
    // Aborted or oversized commands must not keep running detached inside a durable session.
    await removeAfterPrimaryFailure(container, error);
    throw error;
  }

  const inspection = await exec.inspect();
  if (inspection.Running || inspection.ExitCode === null) {
    await removeOrphanedCompute(container);
    throw new Error(
      "AGENT_SANDBOX_RUNNER_PROCESS_STATE_INVALID: Process did not terminate; sandbox compute was removed",
    );
  }

  // GNU timeout returns 137 when an uncooperative process reaches the KILL grace boundary.
  const timedOut = inspection.ExitCode === 124 ||
    (inspection.ExitCode === 137 && Date.now() - startedAt >= timeoutMs);
  const stderrText = timedOut
    ? [
        stderrBytes.toString("utf8").trimEnd(),
        `${PROCESS_TIMED_OUT_MARKER}: Command exceeded ${timeoutMs} ms`,
      ].filter(Boolean).join("\n")
    : stderrBytes.toString("utf8");
  return {
    exitCode: inspection.ExitCode,
    processId: randomUUID(),
    stderr: stderrText,
    stdout: stdoutBytes.toString("utf8"),
  };
}
