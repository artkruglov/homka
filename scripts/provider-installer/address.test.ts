/**
 * Installer public-address tests.
 *
 * Constructs covered:
 * - `discoverPublicIpv4`: requires agreement between independent observations.
 * - `normalizeSslipHostname`: creates one canonical sslip.io hostname.
 * - `validateCustomHostname`: rejects unsafe names and requires exact DNS agreement.
 */
import { describe, expect, it, vi } from "vitest";

import {
  discoverPublicIpv4,
  normalizeSslipHostname,
  validateCustomHostname,
} from "./address.js";

describe("provider installer address", () => {
  it("accepts a public IPv4 observed identically by multiple independent sources", async () => {
    await expect(
      discoverPublicIpv4([
        { id: "first", observe: vi.fn().mockResolvedValue(" 8.8.8.8\n") },
        { id: "second", observe: vi.fn().mockResolvedValue("8.8.8.8") },
        { id: "unavailable", observe: vi.fn().mockRejectedValue(new Error("offline")) },
      ]),
    ).resolves.toBe("8.8.8.8");
  });

  it("fails when valid observations disagree instead of selecting a fallback", async () => {
    await expect(
      discoverPublicIpv4([
        { id: "first", observe: vi.fn().mockResolvedValue("8.8.8.8") },
        { id: "second", observe: vi.fn().mockResolvedValue("1.1.1.1") },
      ]),
    ).rejects.toMatchObject({ code: "OSINARA_INSTALL_PUBLIC_IP_DISAGREEMENT" });
  });

  it("fails when fewer than two independent sources produce an observation", async () => {
    await expect(
      discoverPublicIpv4([
        { id: "first", observe: vi.fn().mockResolvedValue("8.8.8.8") },
        { id: "second", observe: vi.fn().mockRejectedValue(new Error("offline")) },
      ]),
    ).rejects.toMatchObject({ code: "OSINARA_INSTALL_PUBLIC_IP_EVIDENCE_INSUFFICIENT" });
  });

  it("rejects private or otherwise non-public observations", async () => {
    await expect(
      discoverPublicIpv4([
        { id: "first", observe: vi.fn().mockResolvedValue("192.168.1.10") },
        { id: "second", observe: vi.fn().mockResolvedValue("192.168.1.10") },
      ]),
    ).rejects.toMatchObject({ code: "OSINARA_INSTALL_PUBLIC_IP_INVALID" });
  });

  it("normalizes the agreed address to the canonical hyphenated sslip.io form", () => {
    expect(normalizeSslipHostname("8.8.4.4")).toBe("8-8-4-4.sslip.io");
  });

  it("normalizes a custom hostname and requires every A record to match", async () => {
    const resolveIpv4 = vi.fn().mockResolvedValue(["8.8.8.8", "8.8.8.8"]);

    await expect(
      validateCustomHostname("Bot.Example.COM.", "8.8.8.8", resolveIpv4),
    ).resolves.toBe("bot.example.com");
    expect(resolveIpv4).toHaveBeenCalledWith("bot.example.com");
  });

  it("rejects a custom hostname whose DNS includes another server", async () => {
    await expect(
      validateCustomHostname(
        "bot.example.com",
        "8.8.8.8",
        vi.fn().mockResolvedValue(["8.8.8.8", "1.1.1.1"]),
      ),
    ).rejects.toMatchObject({ code: "OSINARA_INSTALL_CUSTOM_DNS_MISMATCH" });
  });

  it.each(["https://example.com", "localhost", "bad_name.example.com", "8.8.8.8"])(
    "rejects invalid custom hostname %s before DNS resolution",
    async (hostname) => {
      const resolveIpv4 = vi.fn();
      await expect(validateCustomHostname(hostname, "8.8.8.8", resolveIpv4)).rejects.toMatchObject({
        code: "OSINARA_INSTALL_CUSTOM_HOSTNAME_INVALID",
      });
      expect(resolveIpv4).not.toHaveBeenCalled();
    },
  );
});
