/**
 * Root/Linux production status, doctor, logs, restart, and owner-bootstrap operations.
 *
 * Exports:
 * - `OperationalHostIdentity`: injectable host identity required by the operational guard.
 * - `assertOperationalHost`: fail-fast root/Linux identity guard.
 * - `requireExactHealthyResponse`: redirect-free exact-URL health validation.
 * - `createProductionOperationalCommands`: secret-free operational actions for an installed host.
 */
import { lstat, readFile, realpath } from "node:fs/promises";

import { parseModelProviderConfigBytes } from "../model-config/schema.js";
import { buildOwnerBootstrapOutput } from "./configuration.js";
import { InstallerError } from "./errors.js";
import { parseBootstrapProcessOutput } from "./host-contracts.js";
import type { OperationalCommandOperations } from "./operational-commands.js";
import { runHostCommand } from "./process-runner.js";

const BASE_DIR = "/opt/osinara";
const ENV_PATH = `${BASE_DIR}/.env`;
const MODEL_CONFIG_PATH = `${BASE_DIR}/agent-model-providers.json`;
const RELEASE_ENV_PATH = `${BASE_DIR}/release.env`;
const COMPOSE_PATH = `${BASE_DIR}/compose.installation.json`;
const MANIFEST_PATH = `${BASE_DIR}/osinara-deployment.json`;
const TLS_ENV_PATH = `${BASE_DIR}/tls/.env`;
const TLS_COMPOSE_PATH = `${BASE_DIR}/tls/compose.tls.yaml`;
const LOCAL_HEALTH_URL = "http://127.0.0.1:8082/eve/v1/health";
const HEALTH_TIMEOUT_MS = 10_000;

export interface OperationalHostIdentity {
  readonly gid: number | undefined;
  readonly platform: string;
  readonly uid: number | undefined;
}

/** Rejects unsupported hosts before reading installation files or invoking Docker. */
export function assertOperationalHost(identity: OperationalHostIdentity): void {
  if (identity.platform !== "linux" || identity.uid !== 0 || identity.gid !== 0) {
    throw new InstallerError(
      "OSINARA_OPERATION_HOST_UNSUPPORTED",
      "Операционные команды Osinara должны выполняться пользователем root на Linux",
    );
  }
}

async function requireManagedFile(path: string, mode: number): Promise<Buffer> {
  const metadata = await lstat(path);
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.uid !== 0
    || metadata.gid !== 0
    || (metadata.mode & 0o777) !== mode
    || await realpath(path) !== path
  ) {
    throw new InstallerError(
      "OSINARA_OPERATION_FILE_INVALID",
      `Файл ${path} имеет небезопасные права, владельца или тип`,
    );
  }
  return await readFile(path);
}

function composeArgs(file: string, envFiles: readonly string[], args: readonly string[]): string[] {
  return ["compose", ...envFiles.flatMap((path) => ["--env-file", path]), "--file", file, ...args];
}

async function compose(
  file: string,
  envFiles: readonly string[],
  args: readonly string[],
): Promise<Buffer> {
  return await runHostCommand({
    args: composeArgs(file, envFiles, args),
    command: "docker",
    timeoutMs: 10 * 60 * 1_000,
  });
}

/** Requires a successful response from the exact URL without following redirects. */
export async function requireExactHealthyResponse(
  url: string,
  fetchImplementation: typeof fetch,
): Promise<void> {
  try {
    const response = await fetchImplementation(url, {
      redirect: "error",
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!response.ok || response.url !== url) {
      throw new Error(`health contract mismatch: ok=${response.ok} exactUrl=${response.url === url}`);
    }
  } catch (error) {
    throw new InstallerError(
      "OSINARA_OPERATION_HEALTH_FAILED",
      `Проверка ${url} не пройдена; выполните osinara doctor`,
      { cause: error },
    );
  }
}

async function installationMetadata(): Promise<{
  address: string;
  model: string;
  provider: string;
  version: string;
}> {
  const [manifestBytes, configBytes, tlsEnvBytes] = await Promise.all([
    requireManagedFile(MANIFEST_PATH, 0o644),
    requireManagedFile(MODEL_CONFIG_PATH, 0o644),
    requireManagedFile(TLS_ENV_PATH, 0o600),
  ]);
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    throw new InstallerError(
      "OSINARA_OPERATION_MANIFEST_INVALID",
      "Deployment manifest повреждён; восстановите installation bundle",
      { cause: error },
    );
  }
  const version = typeof manifest === "object" && manifest !== null && "version" in manifest
    ? manifest.version
    : undefined;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new InstallerError("OSINARA_OPERATION_MANIFEST_INVALID", "Deployment manifest не содержит версию");
  }
  const hostnameLine = tlsEnvBytes.toString("utf8").match(/^OSINARA_HOSTNAME=([^\r\n]+)$/mu);
  if (!hostnameLine?.[1]) {
    throw new InstallerError("OSINARA_OPERATION_TLS_ENV_INVALID", "TLS config не содержит hostname");
  }
  const config = parseModelProviderConfigBytes(configBytes);
  return {
    address: `https://${hostnameLine[1]}`,
    model: config.agent.models.primary.id,
    provider: config.provider,
    version,
  };
}

async function createOwnerBootstrapLink(): Promise<unknown> {
  const environment = (await requireManagedFile(ENV_PATH, 0o600)).toString("utf8");
  const username = environment.match(/^TELEGRAM_BOT_USERNAME='([^']+)'$/mu)?.[1];
  if (!username) {
    throw new InstallerError(
      "OSINARA_OPERATION_TELEGRAM_IDENTITY_INVALID",
      "В установленной конфигурации отсутствует имя Telegram-бота",
    );
  }
  const stdout = await compose(COMPOSE_PATH, [ENV_PATH, RELEASE_ENV_PATH], [
    "run", "--no-deps", "--rm", "--entrypoint", "node", "agent",
    ".runtime/scripts/create-bootstrap-code.js",
  ]);
  const bootstrap = parseBootstrapProcessOutput(stdout);
  return buildOwnerBootstrapOutput({
    botUsername: username,
    code: bootstrap.bootstrapCode,
    expiresAt: bootstrap.bootstrapExpiresAt,
  });
}

/** Operations never return environment contents or raw container configuration. */
export function createProductionOperationalCommands(): OperationalCommandOperations {
  return {
    assertHostPrerequisites: async () => {
      assertOperationalHost({
        gid: process.getgid?.(),
        platform: process.platform,
        uid: process.getuid?.(),
      });
    },
    doctor: async () => {
      await Promise.all([
        requireManagedFile(ENV_PATH, 0o600),
        requireManagedFile(RELEASE_ENV_PATH, 0o600),
        requireManagedFile(COMPOSE_PATH, 0o644),
        requireManagedFile(TLS_COMPOSE_PATH, 0o644),
      ]);
      const metadata = await installationMetadata();
      await compose(COMPOSE_PATH, [ENV_PATH, RELEASE_ENV_PATH], ["config", "--quiet"]);
      await compose(TLS_COMPOSE_PATH, [TLS_ENV_PATH], ["config", "--quiet"]);
      await requireExactHealthyResponse(LOCAL_HEALTH_URL, globalThis.fetch);
      await requireExactHealthyResponse(`${metadata.address}/eve/v1/health`, globalThis.fetch);
      return { code: "OSINARA_DOCTOR_OK", ...metadata };
    },
    logs: async (lines) => {
      const [application, tls] = await Promise.all([
        compose(COMPOSE_PATH, [ENV_PATH, RELEASE_ENV_PATH], [
          "logs", "--no-color", "--no-log-prefix", "--tail", String(lines),
        ]),
        compose(TLS_COMPOSE_PATH, [TLS_ENV_PATH], [
          "logs", "--no-color", "--no-log-prefix", "--tail", String(lines),
        ]),
      ]);
      return {
        application: application.toString("utf8"),
        code: "OSINARA_LOGS_READY",
        tls: tls.toString("utf8"),
      };
    },
    ownerBootstrap: createOwnerBootstrapLink,
    restart: async () => {
      await compose(COMPOSE_PATH, [ENV_PATH, RELEASE_ENV_PATH], [
        "up", "--detach", "--force-recreate", "--no-build", "--wait", "--wait-timeout", "600",
      ]);
      await compose(TLS_COMPOSE_PATH, [TLS_ENV_PATH], [
        "up", "--detach", "--force-recreate", "--no-build", "--wait", "--wait-timeout", "120",
      ]);
      const metadata = await installationMetadata();
      await requireExactHealthyResponse(LOCAL_HEALTH_URL, globalThis.fetch);
      await requireExactHealthyResponse(`${metadata.address}/eve/v1/health`, globalThis.fetch);
      return { code: "OSINARA_RESTART_OK", ...metadata };
    },
    status: async () => {
      const metadata = await installationMetadata();
      await requireExactHealthyResponse(LOCAL_HEALTH_URL, globalThis.fetch);
      await requireExactHealthyResponse(`${metadata.address}/eve/v1/health`, globalThis.fetch);
      return { code: "OSINARA_STATUS_OK", healthy: true, ...metadata };
    },
  };
}
