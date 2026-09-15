/**
 * Root-owned model configuration file-store tests.
 *
 * Constructs covered:
 * - `RootModelConfigFileStore.acquireLock`: a kernel lock outlives only its active holder process.
 * - Lock trust boundary: malformed, live-owner, wrong-mode, and symlink locks remain blocking.
 * - Durable journal I/O: exact mode, replacement, read, and removal behavior.
 */
import { chmod, lstat, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ModelConfigPaths } from "./contracts.js";
import { RootModelConfigFileStore } from "./root-file-store.js";

const TEST_ROOT = `/tmp/osinara-model-config-store-${process.pid}`;
const paths: ModelConfigPaths = {
  configPath: join(TEST_ROOT, "agent-model-providers.json"),
  envPath: join(TEST_ROOT, ".env"),
  journalPath: join(TEST_ROOT, ".model-config.transaction"),
  lockPath: join(TEST_ROOT, ".model-config.lock"),
};
const testSecurity = {
  gid: process.getgid?.() as number,
  uid: process.getuid?.() as number,
};

async function writeLock(contents: string, mode = 0o600): Promise<void> {
  await writeFile(paths.lockPath, contents, { mode });
  await chmod(paths.lockPath, mode);
}

beforeEach(async () => {
  await mkdir(TEST_ROOT, { mode: 0o700 });
  await chmod(TEST_ROOT, 0o700);
});

afterEach(async () => {
  await rm(TEST_ROOT, { force: true, recursive: true });
});

describe("root model configuration lock", () => {
  it("acquires a stale lock file when no process holds its kernel lock", async () => {
    await writeLock("999999999\n");
    const store = new RootModelConfigFileStore(paths, testSecurity);

    const release = await store.acquireLock();

    expect((await lstat(paths.lockPath)).mode & 0o777).toBe(0o600);
    await release();
    await expect(lstat(paths.lockPath)).resolves.toBeDefined();
  });

  it("does not reclaim a lock owned by a live process", async () => {
    const firstStore = new RootModelConfigFileStore(paths, testSecurity);
    const secondStore = new RootModelConfigFileStore(paths, testSecurity);
    const release = await firstStore.acquireLock();

    const competingLock = secondStore.acquireLock();
    await expect(competingLock).rejects.toThrow("OSINARA_MODEL_CONFIG_LOCKED");
    await release();
  });

  it("fails closed for malformed lock contents", async () => {
    await writeLock("not-a-pid\n");
    const store = new RootModelConfigFileStore(paths, testSecurity);

    await expect(store.acquireLock()).rejects.toThrow("OSINARA_MODEL_CONFIG_LOCK_UNTRUSTED");
  });

  it("fails closed when the lock is not root-owned with exact mode", async () => {
    await writeLock("999999999\n", 0o644);
    const store = new RootModelConfigFileStore(paths, testSecurity);

    await expect(store.acquireLock()).rejects.toThrow("OSINARA_MODEL_CONFIG_LOCK_UNTRUSTED");
  });

  it("fails closed when the lock path is a symlink", async () => {
    const targetPath = join(TEST_ROOT, "lock-target");
    await writeFile(targetPath, "999999999\n", { mode: 0o600 });
    await symlink(targetPath, paths.lockPath);
    const store = new RootModelConfigFileStore(paths, testSecurity);

    await expect(store.acquireLock()).rejects.toThrow("OSINARA_MODEL_CONFIG_LOCK_UNTRUSTED");
  });
});

describe("root model configuration journal", () => {
  it("durably replaces, reads, and removes exact journal bytes with restricted mode", async () => {
    const store = new RootModelConfigFileStore(paths, testSecurity);

    await store.writeJournal(Buffer.from("first"));
    await store.writeJournal(Buffer.from("second"));

    expect(await store.readJournal()).toEqual(Buffer.from("second"));
    expect((await lstat(paths.journalPath)).mode & 0o777).toBe(0o600);
    await store.removeJournal();
    await expect(store.readJournal()).resolves.toBeNull();
  });

  it("rejects a journal symlink as untrusted", async () => {
    const targetPath = join(TEST_ROOT, "journal-target");
    await writeFile(targetPath, "{}", { mode: 0o600 });
    await symlink(targetPath, paths.journalPath);
    const store = new RootModelConfigFileStore(paths, testSecurity);

    await expect(store.readJournal()).rejects.toThrow("OSINARA_MODEL_CONFIG_JOURNAL_UNTRUSTED");
  });
});
