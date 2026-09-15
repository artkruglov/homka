/**
 * Native gws credential profile storage.
 *
 * Exports:
 * - `GoogleWorkspaceAuthorizedUserCredentials`: exact gws authorized-user credential contract.
 * - `createGoogleWorkspaceProfileStore`: read-only readiness check and atomic profile writer/remover.
 * - `googleWorkspaceProfileStore`: production store backed by its dedicated Docker volume.
 */
import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { chmod, lstat, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";
import { AppError } from "../app-error.js";

const DIRECTORY_MODE = 0o700;
const CREDENTIAL_MODE = 0o600;
const CREDENTIAL_FILE_NAME = "credentials.json";
const TEMPORARY_CREDENTIAL_PREFIX = ".credentials-";
const TEMPORARY_CREDENTIAL_SUFFIX = ".tmp";
const workspaceIdSchema = z.uuid();

export interface GoogleWorkspaceAuthorizedUserCredentials {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  type: "authorized_user";
}

async function workspaceDirectory(root: string, workspaceId: string): Promise<string> {
  const directory = join(root, workspaceIdSchema.parse(workspaceId));
  try {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory()) {
      throw new AppError("AGENT_GOOGLE_WORKSPACE_PROFILE_PATH_INVALID", "Корень профиля Google должен быть отдельным каталогом без символической ссылки");
    }
  } catch (error) {
    if (!isErrnoException(error, "ENOENT")) throw error;
  }
  return directory;
}

function isErrnoException(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isCredentialStoreEntry(entry: Dirent): boolean {
  return entry.name === CREDENTIAL_FILE_NAME ||
    (entry.name.startsWith(TEMPORARY_CREDENTIAL_PREFIX) &&
      entry.name.endsWith(TEMPORARY_CREDENTIAL_SUFFIX));
}

export function createGoogleWorkspaceProfileStore(root: string) {
  return {
    async exists(workspaceId: string): Promise<boolean> {
      try {
        await stat(join(await workspaceDirectory(root, workspaceId), CREDENTIAL_FILE_NAME));
        return true;
      } catch (error) {
        if (isErrnoException(error, "ENOENT")) return false;
        throw error;
      }
    },

    async remove(workspaceId: string): Promise<void> {
      const directory = await workspaceDirectory(root, workspaceId);
      let entries: Dirent[];
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (isErrnoException(error, "ENOENT")) return;
        throw error;
      }

      // Keep the directory itself stable because active sandboxes bind-mount this exact inode.
      await Promise.all(entries.filter(isCredentialStoreEntry).map((entry) =>
        rm(join(directory, entry.name), { force: true })
      ));
    },

    async write(
      workspaceId: string,
      credentials: GoogleWorkspaceAuthorizedUserCredentials,
    ): Promise<void> {
      const directory = await workspaceDirectory(root, workspaceId);
      await mkdir(directory, { mode: DIRECTORY_MODE, recursive: true });
      await chmod(directory, DIRECTORY_MODE);

      // A same-volume rename ensures gws never observes a partially written refresh token.
      const destination = join(directory, CREDENTIAL_FILE_NAME);
      const temporary = join(
        directory,
        `${TEMPORARY_CREDENTIAL_PREFIX}${randomUUID()}${TEMPORARY_CREDENTIAL_SUFFIX}`,
      );
      try {
        await writeFile(temporary, `${JSON.stringify(credentials, null, 2)}\n`, {
          flag: "wx",
          mode: CREDENTIAL_MODE,
        });
        await rename(temporary, destination);
        await chmod(destination, CREDENTIAL_MODE);
      } finally {
        await rm(temporary, { force: true });
      }
    },
  };
}

export const googleWorkspaceProfileStore = createGoogleWorkspaceProfileStore(
  resolve("google-workspace-credentials"),
);
