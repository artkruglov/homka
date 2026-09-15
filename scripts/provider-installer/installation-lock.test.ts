/**
 * Crash-safe initial installation lock tests.
 *
 * Constructs covered:
 * - `acquireInstallationLock`: stale-file reuse and live kernel exclusion.
 * - Lock metadata boundary: symlink and permissive-mode files are rejected.
 */
import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { acquireInstallationLock } from "./installation-lock.js";

const TEST_ROOT = `/tmp/osinara-install-lock-${process.pid}`;
const LOCK_PATH = join(TEST_ROOT, "install.lock");
const security = {
  gid: process.getgid?.() as number,
  uid: process.getuid?.() as number,
};

beforeEach(async () => {
  await mkdir(TEST_ROOT, { mode: 0o700 });
});

afterEach(async () => {
  await rm(TEST_ROOT, { force: true, recursive: true });
});

describe("initial installation kernel lock", () => {
  it("reuses a trusted stale lock file after the previous process has exited", async () => {
    await writeFile(LOCK_PATH, "999999999\n", { mode: 0o600 });

    const release = await acquireInstallationLock(LOCK_PATH, security);

    const competingLock = acquireInstallationLock(LOCK_PATH, security);
    await expect(competingLock).rejects.toMatchObject({
      code: "OSINARA_INSTALL_LOCKED",
    });
    await release();
    const secondRelease = await acquireInstallationLock(LOCK_PATH, security);
    await secondRelease();
  });

  it("rejects a lock file with permissive mode", async () => {
    await writeFile(LOCK_PATH, "999999999\n", { mode: 0o600 });
    await chmod(LOCK_PATH, 0o644);

    await expect(acquireInstallationLock(LOCK_PATH, security)).rejects.toMatchObject({
      code: "OSINARA_INSTALL_LOCK_UNTRUSTED",
    });
  });

  it("rejects a symbolic lock file", async () => {
    const target = join(TEST_ROOT, "target");
    await writeFile(target, "999999999\n", { mode: 0o600 });
    await symlink(target, LOCK_PATH);

    await expect(acquireInstallationLock(LOCK_PATH, security)).rejects.toMatchObject({
      code: "OSINARA_INSTALL_LOCK_UNTRUSTED",
    });
  });
});
