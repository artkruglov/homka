/**
 * Trusted Gmail approval-subject tests.
 *
 * Constructs covered:
 * - Approval metadata is loaded from the exact live Google profile by immutable message ID.
 * - Only headers and a short provider snippet are exposed; the body is not requested.
 * - A malformed or mismatched provider response fails closed before buttons are shown.
 */
import { describe, expect, it, vi } from "vitest";

import { createGmailMessageApprovalLoader } from "./gmail-message-approval.js";

const auth = {
  familyId: "00000000-0000-4000-8000-000000000001",
  role: "owner" as const,
  scope: "personal" as const,
  telegramUserId: "101",
  userId: "00000000-0000-4000-8000-000000000002",
  workspaceId: "00000000-0000-4000-8000-000000000003",
};

function dependencies(stdout: string) {
  const profile = { displayName: "owner@example.com", profileRef: "profile-1" };
  return {
    resolveAuthorization: vi.fn().mockResolvedValue(auth),
    run: vi.fn().mockResolvedValue({ exitCode: 0, stderr: "", stdout }),
    withAuthorizedExecution: vi.fn(async (_auth, operation) =>
      await operation("live-access-token", profile)
    ),
  };
}

describe("createGmailMessageApprovalLoader", () => {
  it("loads sender, subject, date and a bounded opening for the exact message", async () => {
    const deps = dependencies(JSON.stringify({
      id: "18f1a2b3c4d",
      internalDate: "1788013920000",
      payload: {
        headers: [
          { name: "From", value: "News <news@example.com>" },
          { name: "Subject", value: "Итоги августа" },
          { name: "Date", value: "Sat, 29 Aug 2026 14:32:00 +0300" },
        ],
      },
      snippet: `Короткое начало ${"письма ".repeat(80)}`,
    }));
    const load = createGmailMessageApprovalLoader(deps as never);

    const result = await load("18f1a2b3c4d", "profile-1", { session: {} } as never);

    expect(result).toEqual({
      date: "Sat, 29 Aug 2026 14:32:00 +0300",
      from: "News <news@example.com>",
      id: "18f1a2b3c4d",
      profileDisplayName: "owner@example.com",
      profileRef: "profile-1",
      scope: "personal",
      snippet: expect.stringMatching(/^Короткое начало .+…$/u),
      subject: "Итоги августа",
    });
    expect(result.snippet!.length).toBeLessThanOrEqual(243);
    expect(deps.run).toHaveBeenCalledOnce();
    const argv = deps.run.mock.calls[0]![0] as string[];
    expect(argv.slice(0, 5)).toEqual(["gmail", "users", "messages", "get", "--params"]);
    expect(JSON.parse(argv[5]!)).toEqual({
      format: "metadata",
      id: "18f1a2b3c4d",
      metadataHeaders: ["From", "Subject", "Date"],
      userId: "me",
    });
  });

  it("fails closed when Gmail returns another message", async () => {
    const load = createGmailMessageApprovalLoader(dependencies(JSON.stringify({
      id: "another-message",
      payload: { headers: [] },
    })) as never);

    await expect(load("requested-message", "profile-1", { session: {} } as never)).rejects.toThrowError(
      /AGENT_GMAIL_APPROVAL_SUBJECT_MISMATCH/u,
    );
  });

  it("fails closed when Gmail metadata cannot be decoded", async () => {
    const load = createGmailMessageApprovalLoader(dependencies("not-json") as never);

    await expect(load("requested-message", "profile-1", { session: {} } as never)).rejects.toThrowError(
      /AGENT_GMAIL_APPROVAL_SUBJECT_INVALID/u,
    );
  });

  it("fails before Gmail when the connected profile changed", async () => {
    const deps = dependencies("{}");
    const load = createGmailMessageApprovalLoader(deps as never);

    await expect(load("message-1", "old-profile", { session: {} } as never)).rejects.toThrowError(
      /AGENT_GOOGLE_WORKSPACE_PROFILE_CHANGED/u,
    );
    expect(deps.run).not.toHaveBeenCalled();
  });
});
