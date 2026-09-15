/**
 * Immutable release asset resolver tests.
 *
 * Constructs covered:
 * - `createReleaseAssetsResolver`: downloads one version-pinned installation bundle.
 * - Build metadata validation, bounded responses, and safe network diagnostics.
 */
import { describe, expect, it, vi } from "vitest";

import { createReleaseAssetsResolver } from "./release-assets.js";

const archiveSha256 = "a".repeat(64);

describe("createReleaseAssetsResolver", () => {
  it("downloads only the exact repository tag and asset encoded in the CLI", async () => {
    const archive = Buffer.from("immutable installation bundle");
    const fetch = vi.fn().mockResolvedValue(new Response(archive, { status: 200 }));
    const resolveReleaseAssets = createReleaseAssetsResolver({
      archiveSha256,
      fetch,
      timeoutMs: 30_000,
      version: "0.15.2",
    });

    await expect(resolveReleaseAssets()).resolves.toEqual({
      archive: new Uint8Array(archive),
      archiveSha256,
      version: "0.15.2",
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://github.com/nyxandro/osinara/releases/download/v0.15.2/osinara-installation.tar.gz",
      { headers: { Accept: "application/octet-stream" }, signal: expect.any(AbortSignal) },
    );
  });

  it.each([
    { archiveSha256: "invalid", version: "0.15.2" },
    { archiveSha256, version: "v0.15.2" },
    { archiveSha256, version: "0.15.2-beta.1" },
  ])("rejects invalid embedded release metadata before the network: %#", async (metadata) => {
    const fetch = vi.fn();
    const resolveReleaseAssets = createReleaseAssetsResolver({
      ...metadata,
      fetch,
      timeoutMs: 30_000,
    });

    await expect(resolveReleaseAssets()).rejects.toMatchObject({
      code: "OSINARA_INSTALL_RELEASE_METADATA_INVALID",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an oversized archive even when the server omits Content-Length", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(new Uint8Array(16 * 1024 * 1024 + 1)));
    const resolveReleaseAssets = createReleaseAssetsResolver({
      archiveSha256,
      fetch,
      timeoutMs: 30_000,
      version: "0.15.2",
    });

    await expect(resolveReleaseAssets()).rejects.toMatchObject({
      code: "OSINARA_INSTALL_RELEASE_ARCHIVE_TOO_LARGE",
    });
  });

  it("returns a stable safe error for a failed GitHub release request", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("socket details"));
    const resolveReleaseAssets = createReleaseAssetsResolver({
      archiveSha256,
      fetch,
      timeoutMs: 30_000,
      version: "0.15.2",
    });

    await expect(resolveReleaseAssets()).rejects.toMatchObject({
      code: "OSINARA_INSTALL_RELEASE_DOWNLOAD_FAILED",
      message: expect.stringContaining("Не удалось загрузить installation bundle Osinara v0.15.2"),
    });
  });

  it("rejects invalid timeout configuration before downloading", async () => {
    const fetch = vi.fn();
    const resolveReleaseAssets = createReleaseAssetsResolver({
      archiveSha256,
      fetch,
      timeoutMs: 0,
      version: "0.15.2",
    });

    await expect(resolveReleaseAssets()).rejects.toMatchObject({
      code: "OSINARA_INSTALL_RELEASE_TIMEOUT_INVALID",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
