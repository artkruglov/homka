/**
 * Sandbox repeat guard tests.
 *
 * Constructs covered:
 * - A command that timed out is refused when repeated unchanged within the expiry window, and
 *   allowed again after it; a different command or working directory is never refused.
 * - Through the engine, the refused repeat returns the stable exit code and message without
 *   touching Docker; a successful command is never recorded.
 */
import { PassThrough } from "node:stream";

import type Docker from "dockerode";
import { describe, expect, it, vi } from "vitest";

import { createDockerSandboxEngine } from "./docker-sandbox-engine.js";
import {
  createSandboxRepeatGuard,
  SANDBOX_REPEAT_REFUSED_EXIT_CODE,
  SANDBOX_REPEAT_REFUSED_MESSAGE,
  sandboxCommandFingerprint,
} from "./sandbox-repeat-guard.js";

const SANDBOX_SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("createSandboxRepeatGuard", () => {
  it("refuses an unchanged timed-out command only within the expiry window", () => {
    let clock = 1_000;
    const guard = createSandboxRepeatGuard(() => clock, 60_000);
    const open = sandboxCommandFingerprint("agent-browser open https://a", "/workspace");
    guard.recordTimeout("s1", open);

    expect(guard.refuses("s1", open)).toBe(true);
    expect(guard.refuses("s1", sandboxCommandFingerprint("agent-browser open https://b", "/workspace"))).toBe(false);
    expect(guard.refuses("s1", sandboxCommandFingerprint("agent-browser open https://a", "/tmp"))).toBe(false);
    expect(guard.refuses("s2", open)).toBe(false);
    clock += 61_000;
    expect(guard.refuses("s1", open)).toBe(false);
  });
});

describe("engine repeat guard", () => {
  function engineWithExitCodes(exitCodes: number[], stderr: string) {
    const container = {
      exec: vi.fn(async () => ({
        inspect: vi.fn(async () => ({ ExitCode: exitCodes.shift() ?? 0, Running: false })),
        start: vi.fn(async () => {
          const stream = new PassThrough();
          return stream;
        }),
      })),
      inspect: vi.fn(async () => ({ Config: { Labels: {} }, State: { Running: true } })),
      top: vi.fn(async () => ({ Processes: [] })),
    };
    const docker = {
      getContainer: vi.fn(() => container),
      modem: {
        demuxStream: vi.fn((_stream, stdout, stderrStream) => {
          stderrStream.end(stderr);
          stdout.end();
        }),
      },
    } as unknown as Docker;
    const engine = createDockerSandboxEngine({
      docker,
      roots: { toolsRoot: "/tools", workspaceRoot: "/workspaces" },
      runtime: {
        egressNetwork: "osinara_sandbox-egress",
        image: "osinara-sandbox-runtime:local",
        project: "osinara",
        toolsVolume: "osinara_tool-environments",
        workspaceVolume: "osinara_workspace-data",
      },
    });
    return { container, engine };
  }

  it("refuses the same command after a timeout without running it again", async () => {
    const { container, engine } = engineWithExitCodes([124], "");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const first = await engine.runProcess(SANDBOX_SESSION_ID, { command: "agent-browser open https://a", timeoutMs: 1_000 });
    expect(first.exitCode).toBe(124);
    expect(first.stderr).toContain("AGENT_SANDBOX_RUNNER_PROCESS_TIMED_OUT");

    const second = await engine.runProcess(SANDBOX_SESSION_ID, { command: "agent-browser open https://a", timeoutMs: 1_000 });
    expect(second).toMatchObject({ exitCode: SANDBOX_REPEAT_REFUSED_EXIT_CODE, stderr: SANDBOX_REPEAT_REFUSED_MESSAGE });
    expect(container.exec).toHaveBeenCalledTimes(1);

    const changed = await engine.runProcess(SANDBOX_SESSION_ID, { command: "agent-browser open https://b", timeoutMs: 1_000 });
    expect(changed.exitCode).toBe(0);
    expect(container.exec).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });

  it("never records a command that finished, even with a non-zero exit", async () => {
    const { container, engine } = engineWithExitCodes([1, 1], "");

    await engine.runProcess(SANDBOX_SESSION_ID, { command: "false" });
    const again = await engine.runProcess(SANDBOX_SESSION_ID, { command: "false" });

    expect(again.exitCode).toBe(1);
    expect(container.exec).toHaveBeenCalledTimes(2);
  });
});
