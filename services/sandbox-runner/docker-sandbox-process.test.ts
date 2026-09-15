/**
 * Docker sandbox process lifecycle regression tests.
 *
 * Constructs covered:
 * - Default command timeout and stable timeout diagnostics.
 * - Forced disposable-compute cleanup when Docker exec remains active.
 * - Multiplexed source closure when either bounded output collector fails.
 */
import { PassThrough } from "node:stream";

import type Docker from "dockerode";
import { describe, expect, it, vi } from "vitest";

import { createDockerSandboxEngine } from "./docker-sandbox-engine.js";
import { SANDBOX_RUNNER_MAX_OUTPUT_BYTES } from "../../agent/lib/sandbox-runner/sandbox-runner-contract.js";

const SANDBOX_SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const runtime = {
  egressNetwork: "osinara_sandbox-egress",
  image: "osinara-sandbox-runtime:local",
  project: "osinara",
  toolsVolume: "osinara_tool-environments",
  workspaceVolume: "osinara_workspace-data",
};

function processHarness(
  inspection: { ExitCode: number | null; Running: boolean },
  outputBytes = 0,
  removeError?: Error,
) {
  const remove = vi.fn(async () => {
    if (removeError) throw removeError;
  });
  const source = new PassThrough();
  const exec = {
    inspect: vi.fn(async () => inspection),
    start: vi.fn(async () => source),
  };
  const container = {
    exec: vi.fn(async () => exec),
    inspect: vi.fn(async () => ({ Config: { Labels: {} }, State: { Running: true } })),
      top: vi.fn(async () => ({ Processes: [] })),
    remove,
  };
  const docker = {
    getContainer: vi.fn(() => container),
    modem: {
      demuxStream: vi.fn((_stream, stdout, stderr) => {
        stdout.end(Buffer.alloc(outputBytes));
        stderr.end();
      }),
    },
  } as unknown as Docker;
  const engine = createDockerSandboxEngine({
    docker,
    roots: {
      toolsRoot: "/tools",
      workspaceRoot: "/workspaces",
    },
    runtime,
  });
  return { container, engine, remove, source };
}

describe("Docker sandbox process lifecycle", () => {
  it("bounds commands by default and reports GNU timeout termination", async () => {
    const harness = processHarness({ ExitCode: 124, Running: false });

    await expect(harness.engine.runProcess(SANDBOX_SESSION_ID, { command: "sleep infinity" }))
      .resolves.toMatchObject({
        exitCode: 124,
        stderr: expect.stringContaining("AGENT_SANDBOX_RUNNER_PROCESS_TIMED_OUT"),
      });
    expect(harness.container.exec).toHaveBeenCalledWith(expect.objectContaining({
      Cmd: ["timeout", "--signal=TERM", "--kill-after=5s", "120", "bash", "-c", "sleep infinity"],
    }));
  });

  it("removes disposable compute when an aborted exec is still running", async () => {
    const harness = processHarness({ ExitCode: null, Running: true });

    await expect(harness.engine.runProcess(SANDBOX_SESSION_ID, { command: "stuck-command" }))
      .rejects.toThrowError(/AGENT_SANDBOX_RUNNER_PROCESS_STATE_INVALID/);
    expect(harness.remove).toHaveBeenCalledWith({ force: true, v: true });
  });

  it("closes the multiplexed exec stream when bounded output collection fails", async () => {
    const harness = processHarness(
      { ExitCode: 0, Running: false },
      SANDBOX_RUNNER_MAX_OUTPUT_BYTES + 1,
    );

    await expect(harness.engine.runProcess(SANDBOX_SESSION_ID, { command: "noisy-command" }))
      .rejects.toThrowError(/AGENT_SANDBOX_RUNNER_OUTPUT_TOO_LARGE/);
    expect(harness.source.destroyed).toBe(true);
    expect(harness.remove).toHaveBeenCalledWith({ force: true, v: true });
  });

  it("preserves the primary process error when orphan cleanup also fails", async () => {
    const cleanupError = new Error("Docker remove failed");
    const harness = processHarness(
      { ExitCode: 0, Running: false },
      SANDBOX_RUNNER_MAX_OUTPUT_BYTES + 1,
      cleanupError,
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(harness.engine.runProcess(SANDBOX_SESSION_ID, { command: "noisy-command" }))
      .rejects.toThrowError(/AGENT_SANDBOX_RUNNER_OUTPUT_TOO_LARGE/);
    expect(log).toHaveBeenCalledWith("Sandbox process cleanup failed after primary error", {
      cleanupError: expect.objectContaining({
        cause: cleanupError,
        message: expect.stringContaining("AGENT_SANDBOX_RUNNER_PROCESS_CLEANUP_FAILED"),
      }),
      primaryError: expect.objectContaining({
        message: expect.stringContaining("AGENT_SANDBOX_RUNNER_OUTPUT_TOO_LARGE"),
      }),
    });
    log.mockRestore();
  });
});
