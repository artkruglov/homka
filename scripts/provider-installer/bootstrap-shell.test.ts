/**
 * Shell bootstrap entry tests.
 *
 * Constructs covered:
 * - Required immutable asset URL and SHA-256 arguments.
 * - Checksum-verified CLI persistence before the primary install command starts.
 * - Persistent CLI retention when the primary install command fails.
 * - Source contract excludes repository cloning and local npm builds.
 */
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const bootstrapPath = resolve("scripts/provider-installer/bootstrap.sh");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("provider installer shell bootstrap", () => {
  it("fails clearly when immutable asset coordinates are absent", () => {
    const result = spawnSync("bash", [bootstrapPath], { encoding: "utf8" });
    expect(result.status).toBe(64);
    expect(result.stderr).toContain("OSINARA_BOOTSTRAP_ARGUMENT_MISSING");
  });

  it("persists the checksum-verified CLI before executing its install command", async () => {
    const directory = await mkdtemp(join(tmpdir(), "osinara-bootstrap-test-"));
    temporaryDirectories.push(directory);
    const assetPath = join(directory, "asset");
    const fakeBin = join(directory, "bin");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(fakeBin));
    const asset = "#!/bin/sh\nprintf 'asset:%s\\n' \"$*\" >> \"$TEST_EVENTS\"\nprintf 'asset:%s\\n' \"$*\"\n";
    await writeFile(assetPath, asset);
    await chmod(assetPath, 0o755);
    const checksum = createHash("sha256").update(asset).digest("hex");

    // The fake curl isolates this test from the network while preserving bootstrap argv behavior.
    const fakeCurl = join(fakeBin, "curl");
    await writeFile(
      fakeCurl,
      "#!/bin/sh\nwhile [ \"$#\" -gt 0 ]; do if [ \"$1\" = --output ]; then shift; out=$1; fi; shift; done\ncp \"$TEST_ASSET\" \"$out\"\n",
    );
    await chmod(fakeCurl, 0o755);
    const fakeId = join(fakeBin, "id");
    await writeFile(fakeId, "#!/bin/sh\nprintf '0\\n'\n");
    await chmod(fakeId, 0o755);
    const fakeInstall = join(fakeBin, "install");
    await writeFile(fakeInstall, "#!/bin/sh\nprintf 'persist:%s\\n' \"$*\" >> \"$TEST_EVENTS\"\nexit 0\n");
    await chmod(fakeInstall, 0o755);
    const eventsPath = join(directory, "events");

    const result = spawnSync(
      "bash",
      [bootstrapPath, "https://github.com/nyxandro/osinara/releases/download/v0.15.2/osinara-linux-x64", checksum],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          TEST_ASSET: assetPath,
          TEST_EVENTS: eventsPath,
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("asset:install\n");
    expect((await readFile(eventsPath, "utf8")).split("\n").filter(Boolean)).toEqual([
      expect.stringMatching(/^persist:.*\/usr\/local\/bin\/osinara$/u),
      "asset:install",
    ]);
  });

  it("does not remove the persistent CLI when the primary install command fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "osinara-bootstrap-test-"));
    temporaryDirectories.push(directory);
    const assetPath = join(directory, "asset");
    const fakeBin = join(directory, "bin");
    const persistedMarker = join(directory, "persisted-cli");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(fakeBin));
    const asset = "#!/bin/sh\ntest -f \"$TEST_PERSISTED_MARKER\" || exit 99\nexit 73\n";
    await writeFile(assetPath, asset);
    await chmod(assetPath, 0o755);
    const checksum = createHash("sha256").update(asset).digest("hex");

    // Fake host tools prove ordering and retention without writing to /usr/local.
    await writeFile(
      join(fakeBin, "curl"),
      "#!/bin/sh\nwhile [ \"$#\" -gt 0 ]; do if [ \"$1\" = --output ]; then shift; out=$1; fi; shift; done\ncp \"$TEST_ASSET\" \"$out\"\n",
    );
    await chmod(join(fakeBin, "curl"), 0o755);
    await writeFile(join(fakeBin, "id"), "#!/bin/sh\nprintf '0\\n'\n");
    await chmod(join(fakeBin, "id"), 0o755);
    await writeFile(join(fakeBin, "install"), "#!/bin/sh\nprintf installed > \"$TEST_PERSISTED_MARKER\"\n");
    await chmod(join(fakeBin, "install"), 0o755);

    const result = spawnSync(
      "bash",
      [bootstrapPath, "https://github.com/nyxandro/osinara/releases/download/v0.15.2/osinara-linux-x64", checksum],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          TEST_ASSET: assetPath,
          TEST_PERSISTED_MARKER: persistedMarker,
        },
      },
    );

    expect(result.status).toBe(73);
    expect(await readFile(persistedMarker, "utf8")).toBe("installed");
  });

  it("rejects a downloaded asset whose checksum does not match", async () => {
    const directory = await mkdtemp(join(tmpdir(), "osinara-bootstrap-test-"));
    temporaryDirectories.push(directory);
    const assetPath = join(directory, "asset");
    const fakeBin = join(directory, "bin");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(fakeBin));
    await writeFile(assetPath, "#!/bin/sh\nexit 0\n");
    const fakeCurl = join(fakeBin, "curl");
    await writeFile(
      fakeCurl,
      "#!/bin/sh\nwhile [ \"$#\" -gt 0 ]; do if [ \"$1\" = --output ]; then shift; out=$1; fi; shift; done\ncp \"$TEST_ASSET\" \"$out\"\n",
    );
    await chmod(fakeCurl, 0o755);

    const result = spawnSync(
      "bash",
      [bootstrapPath, "https://github.com/nyxandro/osinara/releases/download/v0.15.2/osinara-linux-x64", "0".repeat(64)],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, TEST_ASSET: assetPath },
      },
    );

    expect(result.status).toBe(65);
    expect(result.stderr).toContain("OSINARA_BOOTSTRAP_CHECKSUM_MISMATCH");
  });

  it("contains no source checkout or package build path", async () => {
    const source = await readFile(bootstrapPath, "utf8");
    expect(source).not.toMatch(/git\s+clone/u);
    expect(source).not.toMatch(/npm\s+(ci|install|run)/u);
  });

  it("installs the operational CLI before invoking the primary install command", async () => {
    const source = await readFile(bootstrapPath, "utf8");
    expect(source).toContain('install -o root -g root -m 0755 "$temporary_asset" /usr/local/bin/osinara');
    expect(source.indexOf('/usr/local/bin/osinara')).toBeLessThan(
      source.indexOf('"$temporary_asset" install'),
    );
  });
});
