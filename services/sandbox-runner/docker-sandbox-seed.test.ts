/**
 * Atomic sandbox seed archive tests.
 *
 * Constructs covered:
 * - Multiple seed files travel through one Docker archive call.
 * - Archive paths, contents, and private file modes survive packing.
 */
import type Docker from "dockerode";
import tar from "tar-stream";
import { describe, expect, it, vi } from "vitest";

import { writeSandboxSeedArchive } from "./docker-sandbox-seed.js";

describe("sandbox seed archive", () => {
  it("packs all seed files into one private archive", async () => {
    const entries: Array<{ content: string; mode: number | undefined; name: string }> = [];
    const putArchive = vi.fn(async (archive: NodeJS.ReadableStream) => {
      await new Promise<void>((resolve, reject) => {
        const extract = tar.extract();
        extract.on("entry", (header, stream, next) => {
          const chunks: Buffer[] = [];
          stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          stream.on("end", () => {
            entries.push({
              content: Buffer.concat(chunks).toString("utf8"),
              mode: header.mode,
              name: header.name,
            });
            next();
          });
        });
        extract.on("finish", resolve);
        extract.on("error", reject);
        archive.on("error", reject);
        archive.pipe(extract);
      });
    });
    const container = { putArchive } as unknown as Docker.Container;

    await writeSandboxSeedArchive(container, [
      { contentBase64: Buffer.from("alpha").toString("base64"), path: "/workspace/a.txt" },
      { contentBase64: Buffer.from("beta").toString("base64"), path: "/tools/personal/b.txt" },
    ]);

    expect(putArchive).toHaveBeenCalledOnce();
    expect(entries).toEqual([
      { content: "alpha", mode: 0o600, name: "workspace/a.txt" },
      { content: "beta", mode: 0o600, name: "tools/personal/b.txt" },
    ]);
  });
});
