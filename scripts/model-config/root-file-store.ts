/**
 * Root-owned durable filesystem implementation for model configuration.
 *
 * Exports:
 * - `RootModelConfigFileStore`: exact-path store with ownership, mode, lock, fsync, and rename checks.
 * - `RootModelConfigFileStoreSecurity`: explicit ownership dependency; production defaults to root.
 */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import type { ModelConfigFileStore, ModelConfigPaths, StagedFile } from "./contracts.js";
import { modelConfigError } from "./errors.js";

const ROOT_UID = 0;
const ROOT_GID = 0;
const LOCK_MODE = 0o600;
const JOURNAL_MODE = 0o600;
const GROUP_OR_WORLD_WRITE_MASK = 0o022;
const PID_PATTERN = /^[1-9][0-9]*\n$/u;
const FLOCK_PATH = "/usr/bin/flock";
const SHELL_PATH = "/bin/sh";
const LOCK_FILE_DESCRIPTOR = 3;
const LOCK_FILE_DESCRIPTOR_PATH = `/proc/self/fd/${LOCK_FILE_DESCRIPTOR}`;
const LOCK_CHILD_SOURCE = `
printf 'locked\\n'
IFS= read -r _ || true
`;

export interface RootModelConfigFileStoreSecurity {
  readonly gid: number;
  readonly uid: number;
}

const ROOT_SECURITY: RootModelConfigFileStoreSecurity = Object.freeze({
  gid: ROOT_GID,
  uid: ROOT_UID,
});

function exactMode(mode: number): number {
  return mode & 0o777;
}

export class RootModelConfigFileStore implements ModelConfigFileStore {
  private readonly stagedPaths = new Set<string>();

  public constructor(
    private readonly paths: ModelConfigPaths,
    private readonly security: RootModelConfigFileStoreSecurity = ROOT_SECURITY,
  ) {}

  private assertDestination(path: string): void {
    if (path !== this.paths.configPath && path !== this.paths.envPath) {
      throw modelConfigError(
        "OSINARA_MODEL_CONFIG_PATH_INVALID",
        "Controller получил путь вне разрешённых файлов конфигурации",
      );
    }
  }

  private async assertSecureAuxiliaryFile(path: string, mode: number, errorCode: string): Promise<void> {
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== this.security.uid ||
      metadata.gid !== this.security.gid ||
      exactMode(metadata.mode) !== mode ||
      await realpath(path) !== path
    ) {
      throw modelConfigError(
        errorCode,
        `Служебный файл ${path} не является доверенным root:root файлом с правами ${mode.toString(8)}`,
      );
    }
  }

  private async syncDirectory(path: string): Promise<void> {
    const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  private async assertRootDirectory(path: string): Promise<void> {
    const directoryPath = dirname(path);
    const metadata = await lstat(directoryPath);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== this.security.uid ||
      metadata.gid !== this.security.gid ||
      (exactMode(metadata.mode) & GROUP_OR_WORLD_WRITE_MASK) !== 0 ||
      await realpath(directoryPath) !== directoryPath
    ) {
      throw modelConfigError(
        "OSINARA_MODEL_CONFIG_DIRECTORY_SECURITY_INVALID",
        `Каталог ${directoryPath} должен быть физическим root:root каталогом без symlink-компонентов`,
      );
    }
  }

  private async openLockFile() {
    let handle;
    try {
      handle = await open(
        this.paths.lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        LOCK_MODE,
      );
      await handle.chown(this.security.uid, this.security.gid);
      await handle.chmod(LOCK_MODE);
      await handle.writeFile(`${process.pid}\n`, "ascii");
      await handle.sync();
      await this.syncDirectory(this.paths.lockPath);
      return handle;
    } catch (error) {
      if (handle) await handle.close();
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    await this.assertSecureAuxiliaryFile(
      this.paths.lockPath,
      LOCK_MODE,
      "OSINARA_MODEL_CONFIG_LOCK_UNTRUSTED",
    );
    const existing = await open(
      this.paths.lockPath,
      constants.O_RDWR | constants.O_NOFOLLOW,
    );
    const contents = await existing.readFile("ascii");
    if (!PID_PATTERN.test(contents)) {
      await existing.close();
      throw modelConfigError(
        "OSINARA_MODEL_CONFIG_LOCK_UNTRUSTED",
        "Lock-файл конфигурации повреждён; требуется проверка оператором",
      );
    }
    return existing;
  }

  private async holdKernelLock(handle: Awaited<ReturnType<typeof open>>) {
    return new Promise<ReturnType<typeof spawn>>((resolvePromise, rejectPromise) => {
      const child = spawn(
        FLOCK_PATH,
        ["--exclusive", "--nonblock", "--no-fork", LOCK_FILE_DESCRIPTOR_PATH, SHELL_PATH, "-c", LOCK_CHILD_SOURCE],
        { stdio: ["pipe", "pipe", "ignore", handle.fd] },
      );
      let settled = false;
      child.once("error", () => {
        if (settled) return;
        settled = true;
        rejectPromise(modelConfigError(
          "OSINARA_MODEL_CONFIG_LOCK_FAILED",
          `Не удалось запустить ${FLOCK_PATH}; установите util-linux и повторите операцию`,
        ));
      });
      child.stdout?.once("data", (message: Buffer) => {
        if (settled || message.toString("ascii") !== "locked\n") return;
        settled = true;
        resolvePromise(child);
      });
      child.once("exit", (code) => {
        if (settled) return;
        settled = true;
        rejectPromise(code === 1
          ? modelConfigError(
              "OSINARA_MODEL_CONFIG_LOCKED",
              "Другая операция изменения конфигурации уже выполняется",
            )
          : modelConfigError(
              "OSINARA_MODEL_CONFIG_LOCK_FAILED",
              `Процесс ${FLOCK_PATH} завершился с кодом ${String(code)} до получения lock`,
            ));
      });
    });
  }

  public async acquireLock(): Promise<() => Promise<void>> {
    await this.assertRootDirectory(this.paths.lockPath);
    const handle = await this.openLockFile();
    let child;
    try {
      child = await this.holdKernelLock(handle);
      // The holder inherited this open-file description; only it may keep the kernel lock alive.
      await handle.close();
    } catch (error) {
      await handle.close();
      throw error;
    }
    return async () => {
      try {
        await new Promise<void>((resolvePromise, rejectPromise) => {
          child.once("error", rejectPromise);
          child.once("exit", (code) => {
            if (code === 0) resolvePromise();
            else rejectPromise(new Error(`lock holder exited with code ${String(code)}`));
          });
          child.stdin?.end();
        });
      } catch {
        throw modelConfigError(
          "OSINARA_MODEL_CONFIG_LOCK_RELEASE_FAILED",
          "Операция завершена, но kernel lock не удалось освободить; проверьте процесс-владелец lock-файла",
        );
      }
    };
  }

  public async assertManagedFile(path: string, mode: number): Promise<void> {
    this.assertDestination(path);
    await this.assertRootDirectory(path);
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== this.security.uid ||
      metadata.gid !== this.security.gid ||
      exactMode(metadata.mode) !== mode ||
      await realpath(path) !== path
    ) {
      throw modelConfigError(
        "OSINARA_MODEL_CONFIG_FILE_SECURITY_INVALID",
        `Файл ${path} должен быть обычным root:root файлом с правами ${mode.toString(8).padStart(4, "0")}`,
      );
    }
  }

  public async commit(staged: StagedFile): Promise<void> {
    this.assertDestination(staged.destinationPath);
    if (!this.stagedPaths.delete(staged.temporaryPath)) {
      throw modelConfigError(
        "OSINARA_MODEL_CONFIG_STAGE_INVALID",
        "Попытка зафиксировать неизвестный временный файл конфигурации",
      );
    }
    await rename(staged.temporaryPath, staged.destinationPath);
    await this.syncDirectory(staged.destinationPath);
  }

  public async discard(staged: StagedFile): Promise<void> {
    this.stagedPaths.delete(staged.temporaryPath);
    await rm(staged.temporaryPath, { force: true });
  }

  public async read(path: string): Promise<Buffer> {
    this.assertDestination(path);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  public async readJournal(): Promise<Buffer | null> {
    await this.assertRootDirectory(this.paths.journalPath);
    try {
      await this.assertSecureAuxiliaryFile(
        this.paths.journalPath,
        JOURNAL_MODE,
        "OSINARA_MODEL_CONFIG_JOURNAL_UNTRUSTED",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const handle = await open(this.paths.journalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  public async removeJournal(): Promise<void> {
    await this.assertSecureAuxiliaryFile(
      this.paths.journalPath,
      JOURNAL_MODE,
      "OSINARA_MODEL_CONFIG_JOURNAL_UNTRUSTED",
    );
    await rm(this.paths.journalPath);
    await this.syncDirectory(this.paths.journalPath);
  }

  public async stage(destinationPath: string, bytes: Buffer, mode: number): Promise<StagedFile> {
    this.assertDestination(destinationPath);
    await this.assertRootDirectory(destinationPath);
    const temporaryPath = resolve(
      dirname(destinationPath),
      `.${basename(destinationPath)}.model-config-${process.pid}-${randomBytes(12).toString("hex")}`,
    );
    const handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      mode,
    );
    try {
      await handle.chown(this.security.uid, this.security.gid);
      await handle.chmod(mode);
      await handle.writeFile(bytes);
      await handle.sync();
      this.stagedPaths.add(temporaryPath);
      return { destinationPath, temporaryPath };
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    } finally {
      await handle.close();
    }
  }

  public async writeJournal(bytes: Buffer): Promise<void> {
    await this.assertRootDirectory(this.paths.journalPath);
    const temporaryPath = resolve(
      dirname(this.paths.journalPath),
      `.${basename(this.paths.journalPath)}-${process.pid}-${randomBytes(12).toString("hex")}`,
    );
    const handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      JOURNAL_MODE,
    );
    try {
      await handle.chown(this.security.uid, this.security.gid);
      await handle.chmod(JOURNAL_MODE);
      await handle.writeFile(bytes);
      await handle.sync();
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    } finally {
      await handle.close();
    }

    // Rename plus directory fsync makes each complete journal phase the only visible state.
    try {
      await rename(temporaryPath, this.paths.journalPath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
    await this.syncDirectory(this.paths.journalPath);
  }
}
