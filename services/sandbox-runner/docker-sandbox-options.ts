/**
 * Pure Docker container configuration for Osinara sandboxes.
 *
 * Exports:
 * - `SandboxDockerRuntime`: resolved Docker resources owned by Compose.
 * - `SANDBOX_CONTAINER_POLICY_VERSION`: invalidates containers created under older runtime policy.
 * - `buildSandboxContainerOptions`: creates fail-closed scoped container options.
 * - `buildGoogleWorkspaceContainerOptions`: creates a one-shot credential boundary.
 * - `resolveTrustedToolMount`: selects the only persistent HOME mount for a trusted session.
 */
import type Docker from "dockerode";

import type {
  GoogleWorkspaceExecutionRequest,
  SandboxRunnerCreateRequest,
  SandboxRunnerMount,
} from "../../agent/lib/sandbox-runner/sandbox-runner-contract.js";

export interface SandboxDockerRuntime {
  egressNetwork: string;
  image: string;
  project: string;
  toolsVolume: string;
  workspaceVolume: string;
}

export const SANDBOX_CONTAINER_POLICY_VERSION = "13";

const AGENT_BROWSER_SESSION_NAME = "osinara";
const AGENT_BROWSER_RESTORE_SAVE_POLICY = "auto";
// One Chromium holds about 500 MiB; the default daemon idle of one hour kept it after every turn.
const AGENT_BROWSER_IDLE_TIMEOUT_MS = 10 * 60 * 1_000;
const PROXY_URL = "http://sandbox-egress-proxy:3128";
const BASE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const GOOGLE_WORKSPACE_BINARY = "/opt/osinara/gws";
const RUSSIAN_TRUSTED_ROOT_CA_PATH =
  "/usr/local/share/ca-certificates/russian-trusted-root-ca.crt";
const SANDBOX_CPU_NANOSECONDS = 1_000_000_000;
const SANDBOX_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
// The pids cgroup counts threads, not processes: one agent-browser Chromium is about 200 tasks,
// so the former limit of 256 wedged page loads inside a single session and a second daemon hit
// EAGAIN outright. The budget now holds a few sessions; anything beyond is leftover daemons.
const SANDBOX_PIDS_LIMIT = 1024;
// Between commands only daemons stay alive (agent-browser and its Chromium tree). Once their
// threads take half the budget the next `mkdir` in the container is at risk of EAGAIN and every
// turn would die in its preamble, so the runner restarts the disposable compute first.
export const SANDBOX_PIDS_REAP_THRESHOLD = SANDBOX_PIDS_LIMIT / 2;
const SANDBOX_SHM_BYTES = 256 * 1024 * 1024;

function volumeMount(source: string, target: string, subpath: string): Docker.MountSettings {
  // Docker Engine accepts Subpath without the optional driver fields over the HTTP API.
  return {
    Source: source,
    Target: target,
    Type: "volume",
    VolumeOptions: { Subpath: subpath },
  } as Docker.MountSettings;
}

function workspaceMounts(
  runtime: SandboxDockerRuntime,
  mounts: readonly SandboxRunnerMount[],
): Docker.MountSettings[] {
  return mounts.map((mount) =>
    volumeMount(runtime.workspaceVolume, `/workspace/${mount.mountPoint}`, mount.workspaceId)
  );
}

export function resolveTrustedToolMount(
  mounts: readonly SandboxRunnerMount[],
): SandboxRunnerMount {
  // Private sessions prefer personal state; family sessions have only their family mount.
  const primary = mounts.find((mount) => mount.mountPoint === "personal") ?? mounts[0];
  if (!primary || primary.mountPoint === "group") {
    throw new Error(
      "AGENT_SANDBOX_RUNNER_TOOL_SCOPE_INVALID: Trusted tool environment is missing",
    );
  }
  return primary;
}

function toolsMount(
  runtime: SandboxDockerRuntime,
  mounts: readonly SandboxRunnerMount[],
): Docker.MountSettings {
  const mount = resolveTrustedToolMount(mounts);
  return volumeMount(runtime.toolsVolume, `/tools/${mount.mountPoint}`, mount.workspaceId);
}

function trustedEnvironment(mounts: readonly SandboxRunnerMount[]): string[] {
  const primary = resolveTrustedToolMount(mounts);
  const root = `/tools/${primary.mountPoint}`;
  const executablePaths = [`${root}/npm/bin`, `${root}/python/bin`, `${root}/bin`];
  return [
    `AGENT_BROWSER_IDLE_TIMEOUT_MS=${AGENT_BROWSER_IDLE_TIMEOUT_MS}`,
    `AGENT_BROWSER_PROXY=${PROXY_URL}`,
    `AGENT_BROWSER_RESTORE=${AGENT_BROWSER_SESSION_NAME}`,
    `AGENT_BROWSER_RESTORE_SAVE=${AGENT_BROWSER_RESTORE_SAVE_POLICY}`,
    `AGENT_BROWSER_SESSION=${AGENT_BROWSER_SESSION_NAME}`,
    // Lightpanda reports usage to its vendor by default; a family sandbox reports nothing.
    "LIGHTPANDA_DISABLE_TELEMETRY=true",
    `HOME=${root}/home`,
    `PATH=${[...executablePaths, BASE_PATH].join(":")}`,
    `NPM_CONFIG_PREFIX=${root}/npm`,
    `NODE_EXTRA_CA_CERTS=${RUSSIAN_TRUSTED_ROOT_CA_PATH}`,
    "NODE_USE_ENV_PROXY=1",
    `PIP_CACHE_DIR=${root}/cache/pip`,
    `PLAYWRIGHT_BROWSERS_PATH=${root}/cache/ms-playwright`,
    `XDG_CACHE_HOME=${root}/cache`,
    `VIRTUAL_ENV=${root}/python`,
    `HTTP_PROXY=${PROXY_URL}`,
    `HTTPS_PROXY=${PROXY_URL}`,
    `http_proxy=${PROXY_URL}`,
    `https_proxy=${PROXY_URL}`,
    "NO_PROXY=localhost,127.0.0.1,sandbox-egress-proxy",
    "LANG=C.UTF-8",
  ];
}

function isolatedEnvironment(): string[] {
  return [
    "HOME=/tmp/home",
    `PATH=${BASE_PATH}`,
    "LANG=C.UTF-8",
  ];
}

export function buildSandboxContainerOptions(
  runtime: SandboxDockerRuntime,
  request: SandboxRunnerCreateRequest,
): Docker.ContainerCreateOptions {
  const trusted = request.access === "trusted";
  const mounts = workspaceMounts(runtime, request.mounts);
  if (trusted) {
    mounts.push(toolsMount(runtime, request.mounts));
  }

  return {
    AttachStderr: false,
    AttachStdin: false,
    AttachStdout: false,
    Cmd: ["sleep", "infinity"],
    Env: trusted ? trustedEnvironment(request.mounts) : isolatedEnvironment(),
    HostConfig: {
      AutoRemove: false,
      CapDrop: ["ALL"],
      // Docker's init process reaps Chromium descendants so durable sandboxes do not exhaust PIDs.
      Init: true,
      Memory: SANDBOX_MEMORY_BYTES,
      Mounts: mounts,
      NanoCpus: SANDBOX_CPU_NANOSECONDS,
      NetworkMode: trusted ? runtime.egressNetwork : "none",
      PidsLimit: SANDBOX_PIDS_LIMIT,
      Privileged: false,
      ReadonlyRootfs: false,
      SecurityOpt: ["no-new-privileges:true"],
      ShmSize: SANDBOX_SHM_BYTES,
      // The shared image contains gws, but durable model-controlled Bash must never see it.
      Tmpfs: {
        "/opt/osinara": "ro,noexec,nosuid,size=64k,mode=0555",
        "/tmp": "rw,noexec,nosuid,size=512m,mode=1777",
      },
    },
    Image: runtime.image,
    Labels: {
      "dev.osinara.sandbox.access": request.access,
      "dev.osinara.sandbox.eve-session-id": request.eveSessionId,
      "dev.osinara.sandbox.policy-version": SANDBOX_CONTAINER_POLICY_VERSION,
      "dev.osinara.sandbox.project": runtime.project,
      "dev.osinara.sandbox.session-id": request.sandboxSessionId,
    },
    OpenStdin: false,
    StdinOnce: false,
    Tty: false,
    WorkingDir: "/workspace",
  };
}

export function buildGoogleWorkspaceContainerOptions(
  runtime: SandboxDockerRuntime,
  request: GoogleWorkspaceExecutionRequest,
): Docker.ContainerCreateOptions {
  return {
    AttachStderr: true,
    AttachStdin: false,
    AttachStdout: true,
    Cmd: [GOOGLE_WORKSPACE_BINARY, ...request.argv],
    Env: [
      `GOOGLE_WORKSPACE_CLI_TOKEN=${request.accessToken}`,
      "HOME=/tmp",
      `HTTP_PROXY=${PROXY_URL}`,
      `HTTPS_PROXY=${PROXY_URL}`,
      "LANG=C.UTF-8",
      "NO_PROXY=localhost,127.0.0.1,sandbox-egress-proxy",
      `http_proxy=${PROXY_URL}`,
      `https_proxy=${PROXY_URL}`,
    ],
    HostConfig: {
      AutoRemove: false,
      CapDrop: ["ALL"],
      Init: true,
      Memory: SANDBOX_MEMORY_BYTES,
      Mounts: [volumeMount(runtime.workspaceVolume, "/workspace", request.workspaceId)],
      NanoCpus: SANDBOX_CPU_NANOSECONDS,
      NetworkMode: runtime.egressNetwork,
      PidsLimit: SANDBOX_PIDS_LIMIT,
      Privileged: false,
      ReadonlyRootfs: true,
      SecurityOpt: ["no-new-privileges:true"],
      Tmpfs: { "/tmp": "rw,noexec,nosuid,size=64m,mode=1777" },
    },
    Image: runtime.image,
    Labels: {
      "dev.osinara.google-workspace-execution": "true",
      "dev.osinara.sandbox.project": runtime.project,
    },
    OpenStdin: false,
    StdinOnce: false,
    Tty: false,
    WorkingDir: "/workspace",
  };
}
