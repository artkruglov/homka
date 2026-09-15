/**
 * Interrupted installation attempt recovery tests.
 *
 * Constructs covered:
 * - `recoverPreMigrationInstallationAttempt`: removes only a root-owned installer attempt.
 * - Durable migration marker: blocks all automatic post-boundary cleanup.
 */
import type { Stats } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  recoverPreMigrationInstallationAttempt,
  type InstallationAttemptFilesystem,
} from "./installation-attempt.js";

const BASE_DIR = "/opt/osinara";
const ATTEMPT_DIR = `${BASE_DIR}/.install-attempt`;
const MIGRATION_MARKER = `${ATTEMPT_DIR}/migration-started`;

function metadata(type: "directory" | "file", mode?: number): Stats {
  return {
    gid: 0,
    isDirectory: () => type === "directory",
    isFile: () => type === "file",
    isSymbolicLink: () => false,
    mode: mode ?? (type === "directory" ? 0o40700 : 0o100600),
    uid: 0,
  } as Stats;
}

function missing(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`missing ${path}`), { code: "ENOENT" });
}

function filesystem(markerExists: boolean): InstallationAttemptFilesystem {
  return {
    lstat: vi.fn(async (path: string) => {
      if (path === BASE_DIR) return metadata("directory", 0o40750);
      if (path === ATTEMPT_DIR) return metadata("directory", 0o40700);
      if (path === MIGRATION_MARKER && markerExists) return metadata("file");
      throw missing(path);
    }),
    realpath: vi.fn(async (path: string) => path),
    rm: vi.fn(async () => undefined),
  };
}

describe("recoverPreMigrationInstallationAttempt", () => {
  it("removes an installer-owned attempt only when no migration marker exists", async () => {
    const fs = filesystem(false);

    await expect(recoverPreMigrationInstallationAttempt({
      attemptDir: ATTEMPT_DIR,
      baseDir: BASE_DIR,
      filesystem: fs,
      migrationMarker: MIGRATION_MARKER,
    })).resolves.toBe(true);

    expect(fs.rm).toHaveBeenCalledWith(BASE_DIR, { recursive: true });
  });

  it("fails closed and preserves the attempt after the durable migration marker", async () => {
    const fs = filesystem(true);

    await expect(recoverPreMigrationInstallationAttempt({
      attemptDir: ATTEMPT_DIR,
      baseDir: BASE_DIR,
      filesystem: fs,
      migrationMarker: MIGRATION_MARKER,
    })).rejects.toMatchObject({ code: "OSINARA_INSTALL_STATE_AMBIGUOUS" });

    expect(fs.rm).not.toHaveBeenCalled();
  });

  it("does not remove an existing directory without an installer attempt marker", async () => {
    const fs = filesystem(false);
    vi.mocked(fs.lstat).mockImplementation(async (path: string) => {
      if (path === BASE_DIR) return metadata("directory", 0o40750);
      throw missing(path);
    });

    await expect(recoverPreMigrationInstallationAttempt({
      attemptDir: ATTEMPT_DIR,
      baseDir: BASE_DIR,
      filesystem: fs,
      migrationMarker: MIGRATION_MARKER,
    })).rejects.toMatchObject({ code: "OSINARA_INSTALL_EXISTING_STATE" });

    expect(fs.rm).not.toHaveBeenCalled();
  });

  it("preserves an attempt whose root ownership metadata is not exact", async () => {
    const fs = filesystem(false);
    vi.mocked(fs.lstat).mockImplementation(async (path: string) => {
      if (path === BASE_DIR) return metadata("directory", 0o40755);
      if (path === ATTEMPT_DIR) return metadata("directory", 0o40700);
      throw missing(path);
    });

    await expect(recoverPreMigrationInstallationAttempt({
      attemptDir: ATTEMPT_DIR,
      baseDir: BASE_DIR,
      filesystem: fs,
      migrationMarker: MIGRATION_MARKER,
    })).rejects.toMatchObject({ code: "OSINARA_INSTALL_ATTEMPT_OWNERSHIP_INVALID" });

    expect(fs.rm).not.toHaveBeenCalled();
  });
});
