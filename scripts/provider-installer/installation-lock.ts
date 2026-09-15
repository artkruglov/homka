/**
 * Crash-safe initial installation process lock.
 *
 * Exports:
 * - `InstallationLockSecurity`: injectable ownership identity for isolated tests.
 * - `acquireInstallationLock`: acquires a non-blocking kernel lock on a trusted persistent file.
 */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";

import { InstallerError } from "./errors.js";

const LOCK_MODE = 0o600;
const FLOCK_PATH = "/usr/bin/flock";
const SHELL_PATH = "/bin/sh";
const LOCK_FILE_DESCRIPTOR = 3;
const LOCK_FILE_DESCRIPTOR_PATH = `/proc/self/fd/${LOCK_FILE_DESCRIPTOR}`;
const LOCK_READY = "locked\n";
const LOCK_HOLDER_SOURCE = `printf '${LOCK_READY}'\nIFS= read -r _ || true\n`;

export interface InstallationLockSecurity {
  readonly gid: number;
  readonly uid: number;
}

const ROOT_SECURITY: InstallationLockSecurity = Object.freeze({ gid: 0, uid: 0 });

async function openTrustedLock(path: string, security: InstallationLockSecurity) {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      LOCK_MODE,
    );
    await handle.chown(security.uid, security.gid);
    await handle.chmod(LOCK_MODE);
    await handle.writeFile(`${process.pid}\n`, "ascii");
    await handle.sync();
    return handle;
  } catch (error) {
    if (handle) await handle.close();
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  // A persistent file is safe to reuse only when its exact host metadata remains trusted.
  const metadata = await lstat(path);
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.uid !== security.uid
    || metadata.gid !== security.gid
    || (metadata.mode & 0o777) !== LOCK_MODE
    || await realpath(path) !== path
  ) {
    throw new InstallerError(
      "OSINARA_INSTALL_LOCK_UNTRUSTED",
      `Lock-файл ${path} имеет небезопасные права, владельца или тип`,
    );
  }
  return await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
}

/** Leaves the trusted file in place; only the kernel lock represents a live owner. */
export async function acquireInstallationLock(
  path: string,
  security: InstallationLockSecurity = ROOT_SECURITY,
): Promise<() => Promise<void>> {
  const handle = await openTrustedLock(path, security);
  const child = spawn(
    FLOCK_PATH,
    ["--exclusive", "--nonblock", "--no-fork", LOCK_FILE_DESCRIPTOR_PATH, SHELL_PATH, "-c", LOCK_HOLDER_SOURCE],
    { stdio: ["pipe", "pipe", "ignore", handle.fd] },
  );

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      child.once("error", () => {
        if (settled) return;
        settled = true;
        reject(new InstallerError(
          "OSINARA_INSTALL_LOCK_FAILED",
          `Не удалось запустить ${FLOCK_PATH}; установите util-linux и повторите операцию`,
        ));
      });
      child.stdout?.once("data", (bytes: Buffer) => {
        if (settled || bytes.toString("ascii") !== LOCK_READY) return;
        settled = true;
        resolve();
      });
      child.once("exit", (code) => {
        if (settled) return;
        settled = true;
        reject(new InstallerError(
          code === 1 ? "OSINARA_INSTALL_LOCKED" : "OSINARA_INSTALL_LOCK_FAILED",
          code === 1
            ? "Другая установка уже выполняется"
            : `Процесс ${FLOCK_PATH} завершился с кодом ${String(code)} до получения lock`,
        ));
      });
    });
    // The holder inherited the same open-file description; parent must drop its duplicate so
    // kernel ownership ends exactly with the holder process, including parent crashes.
    await handle.close();
  } catch (error) {
    await handle.close();
    throw error;
  }

  return async () => {
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => code === 0
          ? resolve()
          : reject(new Error(`lock holder exited with code ${String(code)}`)));
        child.stdin?.end();
      });
    } catch (error) {
      throw new InstallerError(
        "OSINARA_INSTALL_LOCK_RELEASE_FAILED",
        "Операция завершена, но installation lock не удалось освободить; проверьте процесс-владелец",
        { cause: error },
      );
    }
  };
}
