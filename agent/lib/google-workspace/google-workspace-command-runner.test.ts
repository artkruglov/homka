/**
 * Google Workspace command runner failure semantics.
 *
 * Constructs covered:
 * - Transport failures distinguish reads from potentially completed mutations.
 * - Cancellation and timeout preserve exact read/mutation side-effect semantics.
 * - Success and failure diagnostics never expose access tokens or credential-like values.
 */
import { describe, expect, it, vi } from "vitest";

import { createGoogleWorkspaceCommandRunner } from "./google-workspace-command-runner.js";

const auth = {
  familyId: "00000000-0000-4000-8000-000000000001",
  role: "owner" as const,
  scope: "personal" as const,
  telegramUserId: "101",
  userId: "00000000-0000-4000-8000-000000000002",
  workspaceId: "00000000-0000-4000-8000-000000000003",
};

describe("createGoogleWorkspaceCommandRunner", () => {
  it("fails before runner execution when the required access token is missing", async () => {
    const dependencyRun = vi.fn();
    const run = createGoogleWorkspaceCommandRunner({ run: dependencyRun });

    await expect(run(
      ["calendar", "events", "list"],
      "read",
      auth,
      "",
      { abortSignal: new AbortController().signal },
    )).rejects.toMatchObject({
      contract: {
        code: "AGENT_GOOGLE_WORKSPACE_ACCESS_TOKEN_INVALID",
        sideEffectStatus: "not_started",
      },
    });
    expect(dependencyRun).not.toHaveBeenCalled();
  });

  it("marks a mutation transport failure as ambiguous and forbids automatic retry", async () => {
    const run = createGoogleWorkspaceCommandRunner({
      run: vi.fn().mockRejectedValue(new Error("socket closed")),
    });

    await expect(run(
      ["gmail", "users", "messages", "trash", "--params", "{}"],
      "mutation",
      auth,
      "access-token",
      { abortSignal: new AbortController().signal },
    )).rejects.toMatchObject({
      contract: {
        code: "AGENT_GOOGLE_WORKSPACE_EXECUTION_AMBIGUOUS",
        retryable: false,
        sideEffectStatus: "unknown",
      },
    });
  });

  it("allows a read transport failure to be retried", async () => {
    const run = createGoogleWorkspaceCommandRunner({
      run: vi.fn().mockRejectedValue(new Error("socket closed")),
    });

    await expect(run(
      ["gmail", "users", "messages", "list", "--params", "{}"],
      "read",
      auth,
      "access-token",
      { abortSignal: new AbortController().signal },
    )).rejects.toMatchObject({
      contract: {
        code: "AGENT_GOOGLE_WORKSPACE_EXECUTION_FAILED",
        retryable: true,
        sideEffectStatus: "not_started",
      },
    });
  });

  it("returns bounded gws diagnostics and protects mutation failures from blind retry", async () => {
    const run = createGoogleWorkspaceCommandRunner({
      run: vi.fn().mockResolvedValue({
        exitCode: 1,
        processId: "process-1",
        stderr: `Missing required field message.id ${"x".repeat(2_000)}`,
        stdout: "",
      }),
    });

    await expect(run(
      ["gmail", "users", "messages", "trash", "--params", "{}"],
      "mutation",
      auth,
      "access-token",
      { abortSignal: new AbortController().signal },
    )).rejects.toMatchObject({
      contract: {
        code: "AGENT_GOOGLE_WORKSPACE_COMMAND_FAILED",
        retryable: false,
        sideEffectStatus: "unknown",
      },
    });
    await expect(run(
      ["gmail", "users", "messages", "trash", "--params", "{}"],
      "mutation",
      auth,
      "access-token",
      { abortSignal: new AbortController().signal },
    )).rejects.toThrow(/Missing required field message\.id/u);
  });

  it.each([
    ["read", "not_started"],
    ["mutation", "unknown"],
  ] as const)("marks cancelled %s execution without permitting a retry", async (kind, sideEffectStatus) => {
    const controller = new AbortController();
    controller.abort();
    const run = createGoogleWorkspaceCommandRunner({
      run: vi.fn().mockRejectedValue(new Error("request aborted")),
    });

    await expect(run(
      ["calendar", "events", kind === "read" ? "list" : "insert"],
      kind,
      auth,
      "access-token",
      { abortSignal: controller.signal },
    )).rejects.toMatchObject({
      contract: {
        code: "AGENT_GOOGLE_WORKSPACE_EXECUTION_CANCELLED",
        retryable: false,
        sideEffectStatus,
      },
    });
  });

  it.each([
    ["read", true, "not_started"],
    ["mutation", false, "unknown"],
  ] as const)("classifies a timed-out %s command", async (kind, retryable, sideEffectStatus) => {
    const run = createGoogleWorkspaceCommandRunner({
      run: vi.fn().mockResolvedValue({
        exitCode: 124,
        processId: "process-timeout",
        stderr: "timed out",
        stdout: "",
      }),
    });

    await expect(run(
      ["calendar", "events", kind === "read" ? "list" : "insert"],
      kind,
      auth,
      "access-token",
      { abortSignal: new AbortController().signal },
    )).rejects.toMatchObject({
      contract: {
        code: "AGENT_GOOGLE_WORKSPACE_EXECUTION_TIMEOUT",
        retryable,
        sideEffectStatus,
      },
    });
  });

  it("redacts credentials from successful and failed stderr", async () => {
    const secret = "ya29.production-access-token";
    const successful = createGoogleWorkspaceCommandRunner({
      run: vi.fn().mockResolvedValue({
        exitCode: 0,
        processId: "process-success",
        stderr: `Authorization: Bearer ${secret} CLIENT_SECRET=client-secret`,
        stdout: "{}",
      }),
    });
    const failed = createGoogleWorkspaceCommandRunner({
      run: vi.fn().mockResolvedValue({
        exitCode: 1,
        processId: "process-failure",
        stderr: `access_token=${secret} https://user:password@example.com`,
        stdout: "",
      }),
    });

    await expect(successful(
      ["calendar", "events", "list"],
      "read",
      auth,
      secret,
      { abortSignal: new AbortController().signal },
    )).resolves.toMatchObject({
      stderr: expect.not.stringContaining(secret),
    });
    await expect(failed(
      ["calendar", "events", "list"],
      "read",
      auth,
      secret,
      { abortSignal: new AbortController().signal },
    )).rejects.not.toThrow(/production-access-token|client-secret|user:password/u);
  });
});
