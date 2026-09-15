/**
 * Durable initial-install attempt classification and recovery.
 *
 * Exports:
 * - `InstallationAttemptFilesystem`: explicit filesystem dependency used by safe recovery.
 * - `recoverPreMigrationInstallationAttempt`: removes only an installer-owned pre-migration tree.
 *
 * Key constructs:
 * - Exact physical root-owned directory validation before recursive removal.
 * - Migration-marker presence as an unconditional fail-closed boundary.
 */
import type { Stats } from "node:fs";

import { lstat, realpath, rm } from "node:fs/promises";

import { InstallerError } from "./errors.js";

const BASE_DIRECTORY_MODE = 0o750;
const ATTEMPT_DIRECTORY_MODE = 0o700;

export interface InstallationAttemptFilesystem {
  readonly lstat: (path: string) => Promise<Stats>;
  readonly realpath: (path: string) => Promise<string>;
  readonly rm: (path: string, options: { recursive: true }) => Promise<void>;
}

const productionFilesystem: InstallationAttemptFilesystem = { lstat, realpath, rm };

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function requirePhysicalRootDirectory(
  filesystem: InstallationAttemptFilesystem,
  path: string,
  mode: number,
): Promise<void> {
  const metadata = await filesystem.lstat(path);
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || metadata.uid !== 0
    || metadata.gid !== 0
    || (metadata.mode & 0o777) !== mode
    || await filesystem.realpath(path) !== path
  ) {
    throw new InstallerError(
      "OSINARA_INSTALL_ATTEMPT_OWNERSHIP_INVALID",
      `Каталог interrupted attempt ${path} не принадлежит installer; автоматическое удаление запрещено`,
    );
  }
}

async function pathExists(filesystem: InstallationAttemptFilesystem, path: string): Promise<boolean> {
  try {
    await filesystem.lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/** Returns true only when a verified pre-migration attempt was removed for a clean restart. */
export async function recoverPreMigrationInstallationAttempt(input: {
  readonly attemptDir: string;
  readonly baseDir: string;
  readonly filesystem?: InstallationAttemptFilesystem;
  readonly migrationMarker: string;
}): Promise<boolean> {
  const filesystem = input.filesystem ?? productionFilesystem;
  if (!await pathExists(filesystem, input.baseDir)) return false;

  // Any marker object means migration may have started; metadata ambiguity must preserve the tree.
  if (await pathExists(filesystem, input.migrationMarker)) {
    throw new InstallerError(
      "OSINARA_INSTALL_STATE_AMBIGUOUS",
      "Предыдущая установка достигла миграционного рубежа. Автоматический повтор и удаление данных запрещены; выполните osinara doctor",
    );
  }
  if (!await pathExists(filesystem, input.attemptDir)) {
    throw new InstallerError(
      "OSINARA_INSTALL_EXISTING_STATE",
      "На сервере уже существует /opt/osinara без installer attempt marker; используйте диагностику",
    );
  }

  // Exact ownership and modes distinguish the installer's fresh tree from unrelated host data.
  await requirePhysicalRootDirectory(filesystem, input.baseDir, BASE_DIRECTORY_MODE);
  await requirePhysicalRootDirectory(filesystem, input.attemptDir, ATTEMPT_DIRECTORY_MODE);
  await filesystem.rm(input.baseDir, { recursive: true });
  return true;
}
