/**
 * Approval timeout sweep trigger tests.
 *
 * Constructs covered:
 * - `createApprovalTimeoutSweep`: posts to the private route with the internal token.
 * - A failed cycle is reported and swallowed so the minute schedule keeps running.
 * - Missing required config is not swallowed: it surfaces instead of disabling the sweep.
 * - `isInternalTokenAuthorized`: rejects a missing, short, long, or wrong token.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  APPROVAL_TIMEOUT_ROUTE,
  APPROVAL_TIMEOUT_TOKEN_HEADER,
  createApprovalTimeoutSweep,
  isInternalTokenAuthorized,
} from "./approval-timeout-sweep.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createApprovalTimeoutSweep", () => {
  it("posts to the internal route with the internal token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await createApprovalTimeoutSweep({ fetch: fetchMock, token: () => "secret" })();

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain(APPROVAL_TIMEOUT_ROUTE);
    expect(String(url).startsWith("http://127.0.0.1:3000")).toBe(true);
    expect((init as RequestInit).method).toBe("POST");
    expect((init as { headers: Record<string, string> }).headers[APPROVAL_TIMEOUT_TOKEN_HEADER])
      .toBe("secret");
  });

  it("reports a rejected cycle without breaking the minute schedule", async () => {
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));

    await expect(
      createApprovalTimeoutSweep({ fetch: fetchMock, token: () => "secret" })(),
    ).resolves.toBeUndefined();
    expect(reported.mock.calls[0]![0]).toContain("AGENT_APPROVAL_TIMEOUT_SWEEP_FAILED");
  });

  it("fails fast and sends nothing when the internal token is missing", async () => {
    const fetchMock = vi.fn();
    const sweep = createApprovalTimeoutSweep({
      fetch: fetchMock,
      token: () => {
        throw new Error("AGENT_INTERNAL_TOKEN_MISSING: no token");
      },
    });

    // Missing required config is not a transient cycle failure and must not be swallowed.
    await expect(sweep()).rejects.toThrow(/AGENT_INTERNAL_TOKEN_MISSING/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("isInternalTokenAuthorized", () => {
  it("accepts only the exact token", () => {
    expect(isInternalTokenAuthorized("secret-token", "secret-token")).toBe(true);
  });

  it("rejects a missing header without throwing", () => {
    expect(isInternalTokenAuthorized(null, "secret-token")).toBe(false);
  });

  it("rejects wrong tokens of equal and unequal length", () => {
    expect(isInternalTokenAuthorized("secret-tokes", "secret-token")).toBe(false);
    expect(isInternalTokenAuthorized("secret", "secret-token")).toBe(false);
    expect(isInternalTokenAuthorized("secret-token-extra", "secret-token")).toBe(false);
    expect(isInternalTokenAuthorized("", "secret-token")).toBe(false);
  });
});
