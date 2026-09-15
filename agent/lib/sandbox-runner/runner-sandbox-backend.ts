/**
 * Eve backend for the isolated Osinara sandbox runner.
 *
 * Exports:
 * - `scopedWorkspaceRunner`: real-Bash backend with trusted scoped tools persistence.
 * - `deleteRunnerToolEnvironment`: removes persistent tools when their workspace is deleted.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";

import type {
  SandboxBackend,
  SandboxBackendPrewarmInput,
  SandboxProcess,
  SandboxSeedFile,
  SandboxSession,
  SandboxSpawnOptions,
} from "eve/sandbox";
import { SandboxTemplateNotProvisionedError } from "eve/sandbox";

import { SANDBOX_RUNNER_BASE_URL } from "../../config.js";
import type {
  SandboxAccess,
  SandboxRunnerCreateRequest,
  SandboxRunnerSeedFile,
  WorkspaceSandboxMount,
  WorkspaceSandboxUseOptions,
} from "./sandbox-runner-contract.js";
import {
  parseCreateSandboxRequest,
  parseSandboxEveSessionId,
  parseWorkspaceSandboxUseOptions,
  sandboxSeedDigest,
} from "./sandbox-runner-contract.js";
import { SandboxRunnerClient } from "./runner-client.js";
import {
  accessForMounts,
  type BackendProfile,
  ROOT_RUNNER_PROFILE,
  sandboxHome,
} from "./runner-sandbox-profile.js";
import { parseStoredSandboxMetadata } from "./runner-sandbox-state.js";

const TEMPLATE_SCHEMA_VERSION = 1;

interface BackendOptions {
  baseUrl?: string;
}

interface StoredTemplate {
  files: Array<{ contentBase64: string; path: string }>;
  version: number;
}

function templatePath(appRoot: string, cacheDirectory: string, templateKey: string): string {
  return join(appRoot, ".eve", "sandbox-cache", cacheDirectory, "templates", `${templateKey}.json`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function encodeTemplate(seedFiles: ReadonlyArray<SandboxSeedFile>): StoredTemplate {
  return {
    files: seedFiles.map((file) => ({
      contentBase64: Buffer.from(file.content).toString("base64"),
      path: file.path,
    })),
    version: TEMPLATE_SCHEMA_VERSION,
  };
}

async function loadTemplate(
  appRoot: string,
  templateKey: string,
  profile: BackendProfile,
): Promise<StoredTemplate> {
  const path = templatePath(appRoot, profile.cacheDirectory, templateKey);
  if (!await exists(path)) {
    throw new SandboxTemplateNotProvisionedError({ backendName: profile.name, templateKey });
  }
  const template = JSON.parse(await readFile(path, "utf8")) as StoredTemplate;
  if (template.version !== TEMPLATE_SCHEMA_VERSION || !Array.isArray(template.files)) {
    throw new Error("AGENT_SANDBOX_RUNNER_TEMPLATE_INVALID: Template schema mismatch");
  }
  return template;
}

function resolveSandboxPath(path: string): string {
  return path.startsWith("/") ? posix.normalize(path) : posix.resolve("/workspace", path);
}

async function streamBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function resultStream(
  completion: Promise<{ stderr: string; stdout: string }>,
  field: "stderr" | "stdout",
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      const value = (await completion)[field];
      if (value) controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

function resolveSeedPath(
  path: string,
  access: SandboxAccess,
  mounts: readonly WorkspaceSandboxMount[],
): string {
  const homePrefix = "$HOME/";
  if (path.startsWith(homePrefix)) return `${sandboxHome(access, mounts)}/${path.slice(homePrefix.length)}`;
  if (path.startsWith("$HOME")) {
    throw new Error("AGENT_SANDBOX_RUNNER_SEED_PATH_INVALID: HOME seed path is malformed");
  }
  return resolveSandboxPath(path);
}

function seedManifest(
  template: StoredTemplate | null,
  access: SandboxAccess,
  mounts: readonly WorkspaceSandboxMount[],
): { seedDigest: string; seedFiles: SandboxRunnerSeedFile[] } {
  const seedFiles = (template?.files ?? []).map((file) => ({
    contentBase64: file.contentBase64,
    path: resolveSeedPath(file.path, access, mounts),
  }));
  return { seedDigest: sandboxSeedDigest(seedFiles), seedFiles };
}

function buildSession(input: {
  access: () => SandboxAccess | null;
  client: SandboxRunnerClient;
  ensure: () => Promise<string>;
  id: () => string;
}): SandboxSession {
  async function spawn(options: SandboxSpawnOptions): Promise<SandboxProcess> {
    const sessionId = await input.ensure();
    const controller = new AbortController();
    let killed = false;
    const completion = input.client.run(sessionId, {
      command: options.command,
      environment: options.env,
      workingDirectory: options.workingDirectory,
    }, controller.signal).catch((error: unknown) => {
      if (killed) return { exitCode: 137, processId: "killed", stderr: "", stdout: "" };
      throw error;
    });
    options.abortSignal?.addEventListener("abort", () => controller.abort(), { once: true });
    return {
      stderr: resultStream(completion, "stderr"),
      stdout: resultStream(completion, "stdout"),
      async kill() {
        if (killed) return;
        killed = true;
        controller.abort();
        await input.client.stop(sessionId);
      },
      async wait() {
        return { exitCode: (await completion).exitCode };
      },
    };
  }

  async function readBytes(path: string, signal?: AbortSignal): Promise<Uint8Array | null> {
    return await input.client.readFile(await input.ensure(), resolveSandboxPath(path), signal);
  }

  async function writeBytes(path: string, content: Uint8Array, signal?: AbortSignal): Promise<void> {
    await input.client.writeFile(await input.ensure(), resolveSandboxPath(path), content, signal);
  }

  return {
    get id() {
      return input.id();
    },
    resolvePath: resolveSandboxPath,
    async run(options) {
      const result = await input.client.run(await input.ensure(), {
        command: options.command,
        environment: options.env,
        workingDirectory: options.workingDirectory,
      }, options.abortSignal);
      return { exitCode: result.exitCode, stderr: result.stderr, stdout: result.stdout };
    },
    spawn,
    async readFile(options) {
      const bytes = await readBytes(options.path, options.abortSignal);
      return bytes === null ? null : byteStream(bytes);
    },
    readBinaryFile: (options) => readBytes(options.path, options.abortSignal),
    async readTextFile(options) {
      const bytes = await readBytes(options.path, options.abortSignal);
      if (bytes === null) return null;
      const encoding = options.encoding ?? "utf8";
      if (!Buffer.isEncoding(encoding)) {
        throw new Error("AGENT_SANDBOX_RUNNER_ENCODING_INVALID: File encoding is unsupported");
      }
      const text = Buffer.from(bytes).toString(encoding);
      if (options.startLine === undefined && options.endLine === undefined) return text;
      const lines = text.match(/.*(?:\r\n|\n|\r|$)/gu)?.filter(Boolean) ?? [];
      return lines.slice((options.startLine ?? 1) - 1, options.endLine).join("");
    },
    async writeFile(options) {
      await writeBytes(options.path, await streamBytes(options.content), options.abortSignal);
    },
    writeBinaryFile: (options) => writeBytes(options.path, options.content, options.abortSignal),
    async writeTextFile(options) {
      const encoding = options.encoding ?? "utf8";
      if (!Buffer.isEncoding(encoding)) {
        throw new Error("AGENT_SANDBOX_RUNNER_ENCODING_INVALID: File encoding is unsupported");
      }
      await writeBytes(options.path, Buffer.from(options.content, encoding), options.abortSignal);
    },
    async removePath(options) {
      await input.client.removePath(await input.ensure(), {
        force: options.force,
        path: resolveSandboxPath(options.path),
        recursive: options.recursive,
      }, options.abortSignal);
    },
    async setNetworkPolicy(policy) {
      const access = input.access();
      const valid = (access === "trusted" && policy === "allow-all") ||
        (access !== "trusted" && access !== null && policy === "deny-all");
      if (!valid) {
        throw new Error(
          "AGENT_SANDBOX_RUNNER_NETWORK_POLICY_FORBIDDEN: Session network policy is immutable",
        );
      }
    },
  };
}

function workspaceRunner(
  profile: BackendProfile,
  options: BackendOptions,
): SandboxBackend<
  Record<string, never>,
  WorkspaceSandboxUseOptions
> {
  const client = new SandboxRunnerClient(options.baseUrl ?? SANDBOX_RUNNER_BASE_URL);
  return {
    name: profile.name,
    async prewarm(input: SandboxBackendPrewarmInput<Record<string, never>>) {
      if (input.bootstrap) {
        throw new Error("AGENT_SANDBOX_RUNNER_BOOTSTRAP_UNSUPPORTED: Use Eve seed files");
      }
      const path = templatePath(
        input.runtimeContext.appRoot,
        profile.cacheDirectory,
        input.templateKey,
      );
      if (await exists(path)) return { reused: true };
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(encodeTemplate(input.seedFiles)), { flag: "wx" });
      return { reused: false };
    },
    async create(input) {
      const template = input.templateKey === null
        ? null
        : await loadTemplate(input.runtimeContext.appRoot, input.templateKey, profile);
      // A thread ID survives normal context rotation while a trust-zone replacement gets a new ID.
      const eveSessionId = parseSandboxEveSessionId(input.tags?.sessionId);
      const restored = parseStoredSandboxMetadata(
        input.existingMetadata,
        eveSessionId,
        profile.stateSchemaVersion,
      );
      let request: SandboxRunnerCreateRequest | null = restored && !restored.disabled
        ? parseCreateSandboxRequest({
          access: restored.access,
          eveSessionId,
          mounts: restored.mounts,
          sandboxSessionId: restored.sandboxSessionId,
          ...seedManifest(template, restored.access, restored.mounts),
        })
        : null;
      let disabledSandboxSessionId = restored?.disabled
        ? restored.sandboxSessionId
        : null;
      const requireRequest = (): SandboxRunnerCreateRequest => {
        if (disabledSandboxSessionId) {
          throw new Error(
            "AGENT_SANDBOX_RUNNER_SESSION_DISABLED: Sandbox access is disabled for this session",
          );
        }
        if (!request) {
          throw new Error(
            "AGENT_SANDBOX_RUNNER_SESSION_MISSING: Sandbox session is not mounted",
          );
        }
        return request;
      };
      const runnerSessionId = () => {
        if (disabledSandboxSessionId) return disabledSandboxSessionId;
        return requireRequest().sandboxSessionId;
      };
      const ensureRunner = async (): Promise<string> => {
        const current = requireRequest();
        const probe = await client.create({ ...current, seedFiles: undefined });
        if (probe.seedRequired) {
          const created = await client.create(current);
          if (created.seedRequired) {
            throw new Error("AGENT_SANDBOX_RUNNER_SEED_REQUIRED: Runner rejected the seed bundle");
          }
        }
        return current.sandboxSessionId;
      };
      const session = buildSession({
        access: () => request?.access ?? null,
        client,
        ensure: ensureRunner,
        id: runnerSessionId,
      });
      const stopRunner = async (): Promise<void> => {
        // Both lifecycle boundaries preserve metadata; the runner operation is intentionally idempotent.
        if (request) await client.stop(request.sandboxSessionId);
      };
      return {
        session,
        async useSessionFn(useOptions) {
          if (!useOptions) throw new Error("AGENT_SANDBOX_RUNNER_MOUNTS_MISSING: Mounts are required");
          const parsedOptions = parseWorkspaceSandboxUseOptions(useOptions);
          if (parsedOptions.mounts.length === 0) {
            if (request || (disabledSandboxSessionId &&
                disabledSandboxSessionId !== parsedOptions.sandboxSessionId)) {
              throw new Error("AGENT_SANDBOX_RUNNER_REMOUNT_DENIED: Session mounts are immutable");
            }
            disabledSandboxSessionId = parsedOptions.sandboxSessionId;
            return session;
          }
          if (disabledSandboxSessionId) {
            throw new Error("AGENT_SANDBOX_RUNNER_REMOUNT_DENIED: Session mounts are immutable");
          }
          if (request) {
            if (
              request.sandboxSessionId !== parsedOptions.sandboxSessionId ||
              JSON.stringify(request.mounts) !== JSON.stringify(parsedOptions.mounts)
            ) {
              throw new Error("AGENT_SANDBOX_RUNNER_REMOUNT_DENIED: Session mounts are immutable");
            }
            return session;
          }
          const access = accessForMounts(parsedOptions.mounts);
          request = parseCreateSandboxRequest({
            access,
            eveSessionId,
            mounts: parsedOptions.mounts,
            sandboxSessionId: parsedOptions.sandboxSessionId,
            ...seedManifest(template, access, parsedOptions.mounts),
          });
          return session;
        },
        async captureState() {
          if (disabledSandboxSessionId) {
            return {
              backendName: profile.name,
              metadata: {
                disabled: true,
                mounts: [],
                sandboxSessionId: disabledSandboxSessionId,
                version: profile.stateSchemaVersion,
              },
              sessionKey: input.sessionKey,
            };
          }
          const current = requireRequest();
          return {
            backendName: profile.name,
            metadata: {
              access: current.access,
              mounts: current.mounts,
              sandboxSessionId: current.sandboxSessionId,
              version: profile.stateSchemaVersion,
            },
            sessionKey: input.sessionKey,
          };
        },
        shutdown: stopRunner,
        stop: stopRunner,
      };
    },
  };
}

export function scopedWorkspaceRunner(options: BackendOptions = {}): SandboxBackend<
  Record<string, never>,
  WorkspaceSandboxUseOptions
> {
  return workspaceRunner(ROOT_RUNNER_PROFILE, options);
}

export async function deleteRunnerToolEnvironment(
  workspaceId: string,
  baseUrl = SANDBOX_RUNNER_BASE_URL,
): Promise<void> {
  await new SandboxRunnerClient(baseUrl).deleteToolEnvironment(workspaceId);
}
