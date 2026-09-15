/**
 * Standalone installer CLI artifact tests.
 *
 * Constructs covered:
 * - `build-provider-installer-cli.sh`: creates one self-contained glibc GNU/Linux x86_64 executable.
 * - Runtime independence: the published artifact starts without Node.js or project files on PATH.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const buildScript = resolve("scripts/provider-installer/build-provider-installer-cli.sh");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("standalone provider installer CLI", () => {
  it("builds and starts one executable without a Node.js runtime on PATH", async () => {
    const directory = await mkdtemp(join(tmpdir(), "osinara-cli-build-test-"));
    temporaryDirectories.push(directory);
    const executable = join(directory, "osinara-linux-x64");

    const build = spawnSync("bash", [
      buildScript,
      executable,
      "0.15.2",
      "a".repeat(64),
    ], {
      cwd: resolve("."),
      encoding: "utf8",
    });
    expect(build.status, build.stderr).toBe(0);

    const result = spawnSync(executable, ["--help"], {
      cwd: directory,
      encoding: "utf8",
      env: { PATH: "/nonexistent" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("osinara install");
  }, 30_000);
});
