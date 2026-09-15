/**
 * Installer network adapter tests.
 *
 * Constructs covered:
 * - `createPublicIpv4Sources`: three independently operated HTTPS observers with bounded requests.
 * - `createTelegramGetMe`: Bot API getMe transport without accepting caller-supplied identity.
 */
import { describe, expect, it, vi } from "vitest";

import { createPublicIpv4Sources, createTelegramGetMe } from "./network-adapters.js";

describe("provider installer network adapters", () => {
  it("builds three distinct public IPv4 observers and requires successful HTTP responses", async () => {
    const fetchImplementation = vi.fn().mockImplementation(async () =>
      new Response("8.8.8.8\n", { status: 200 }));
    const sources = createPublicIpv4Sources(fetchImplementation);

    expect(sources.map(({ id }) => id)).toEqual(["ipify", "aws-checkip", "icanhazip"]);
    await expect(Promise.all(sources.map(({ observe }) => observe()))).resolves.toEqual([
      "8.8.8.8\n",
      "8.8.8.8\n",
      "8.8.8.8\n",
    ]);
    expect(new Set(fetchImplementation.mock.calls.map(([url]) => new URL(String(url)).hostname)).size)
      .toBe(3);
  });

  it("rejects a failed observation so it cannot count as agreement evidence", async () => {
    const [source] = createPublicIpv4Sources(
      vi.fn().mockResolvedValue(new Response("upstream failed", { status: 503 })),
    );
    await expect(source?.observe()).rejects.toMatchObject({
      code: "OSINARA_INSTALL_PUBLIC_IP_SOURCE_FAILED",
    });
  });

  it("calls Telegram getMe through HTTPS and decodes its response", async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      Response.json({
        ok: true,
        result: { id: 123456, is_bot: true, username: "Osinara_Test_Bot" },
      }),
    );
    const getMe = createTelegramGetMe(fetchImplementation);

    await expect(getMe("123456:Abc_def-123")).resolves.toMatchObject({ ok: true });
    expect(fetchImplementation).toHaveBeenCalledWith(
      "https://api.telegram.org/bot123456:Abc_def-123/getMe",
      expect.objectContaining({ method: "GET", signal: expect.any(AbortSignal) }),
    );
  });

  it("fails with a stable code when Telegram transport or JSON is unavailable", async () => {
    const getMe = createTelegramGetMe(
      vi.fn().mockResolvedValue(new Response("not json", { status: 502 })),
    );
    await expect(getMe("123456:Abc_def-123")).rejects.toMatchObject({
      code: "OSINARA_INSTALL_TELEGRAM_REQUEST_FAILED",
    });
  });
});
