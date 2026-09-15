/**
 * Public DNS resolution tests for sandbox egress.
 *
 * Constructs covered:
 * - Public answers are selected even when the host DNS also returns VPN fake-IP addresses.
 * - Private, reserved, and fake-IP-only answers remain blocked by the SSRF policy.
 * - IPv4 DNS failure never falls through to an unusable public AAAA answer.
 */
import { describe, expect, it, vi } from "vitest";

import {
  resolvePublicInternetAddress,
  type PublicDnsClient,
} from "./public-dns-resolver.js";

function dnsClient(ipv4: string[]): PublicDnsClient {
  return {
    resolve4: vi.fn(async () => ipv4),
  };
}

describe("resolvePublicInternetAddress", () => {
  it("ignores a VPN fake-IP answer and pins a real public address", async () => {
    const result = await resolvePublicInternetAddress(
      "github.com",
      dnsClient(["198.18.0.4", "140.82.121.4"]),
    );

    expect(result).toEqual({ address: "140.82.121.4", family: 4 });
  });

  it("rejects a destination when DNS returns only non-public addresses", async () => {
    await expect(
      resolvePublicInternetAddress("internal.example", dnsClient(["198.18.0.4", "10.0.0.1"])),
    ).rejects.toThrow("AGENT_SANDBOX_EGRESS_DESTINATION_FORBIDDEN");
  });

  it("fails on an A-query error without falling through to a public AAAA answer", async () => {
    const dnsError = Object.assign(new Error("A query timed out"), { code: "ETIMEOUT" });
    const client = {
      resolve4: vi.fn(async () => Promise.reject(dnsError)),
      resolve6: vi.fn(async () => ["2607:f8b0:4005:80a::2004"]),
    };

    const resolution = resolvePublicInternetAddress("www.googleapis.com", client);

    await expect(resolution).rejects.toMatchObject({
      cause: dnsError,
      message: expect.stringContaining("AGENT_SANDBOX_EGRESS_IPV4_RESOLUTION_FAILED"),
    });
    expect(client.resolve6).not.toHaveBeenCalled();
  });
});
