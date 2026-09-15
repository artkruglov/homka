/**
 * DeepSeek balance reader tests.
 *
 * Constructs covered:
 * - The documented `/user/balance` answer becomes availability and a dollar total.
 * - A network failure, a refusal or a non-DeepSeek installation yields null and never throws.
 */
import { describe, expect, it, vi } from "vitest";

import { readDeepSeekBalance } from "./deepseek-balance.js";

const deepseek = { apiKey: "sk-test", baseUrl: "https://api.deepseek.com/anthropic", provider: "deepseek" };

describe("readDeepSeekBalance", () => {
  it("reads availability and the USD total with the model key", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      balance_infos: [
        { currency: "CNY", granted_balance: "0.00", topped_up_balance: "10.00", total_balance: "10.00" },
        { currency: "USD", granted_balance: "0.00", topped_up_balance: "-0.04", total_balance: "-0.04" },
      ],
      is_available: false,
    }), { headers: { "content-type": "application/json" }, status: 200 }));

    await expect(readDeepSeekBalance({ ...deepseek, fetch })).resolves.toEqual({ available: false, totalUsd: -0.04 });
    expect(fetch).toHaveBeenCalledWith("https://api.deepseek.com/user/balance", expect.objectContaining({
      headers: { accept: "application/json", authorization: "Bearer sk-test" },
    }));
  });

  it("returns null without a call for another provider or host", async () => {
    const fetch = vi.fn();
    await expect(readDeepSeekBalance({ ...deepseek, fetch, provider: "openai" })).resolves.toBeNull();
    await expect(readDeepSeekBalance({ ...deepseek, baseUrl: "https://api.minimax.io/anthropic", fetch })).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("logs and returns null on refusal, malformed answer or network failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(readDeepSeekBalance({ ...deepseek, fetch: vi.fn().mockResolvedValue(new Response("no", { status: 401 })) }))
      .resolves.toBeNull();
    await expect(readDeepSeekBalance({ ...deepseek, fetch: vi.fn().mockResolvedValue(new Response("{}", { status: 200 })) }))
      .resolves.toBeNull();
    await expect(readDeepSeekBalance({ ...deepseek, fetch: vi.fn().mockRejectedValue(new Error("offline")) }))
      .resolves.toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("AGENT_DEEPSEEK_BALANCE_UNREADABLE"));
    expect(error.mock.calls.join("")).not.toContain("sk-test");
    error.mockRestore();
  });
});
