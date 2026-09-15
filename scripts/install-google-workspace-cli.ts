/**
 * Checksum-pinned Google Workspace CLI binary installer for Docker builds.
 *
 * Exports:
 * - `GWS_VERSION`: exact npm package and release version.
 * - `resolveGoogleWorkspaceCliArtifact`: Linux architecture to official artifact/checksum mapping.
 * - `resolveGoogleWorkspaceCliDownloadUrl`: official GitHub release URL for a pinned artifact.
 * - `installGoogleWorkspaceCli`: verified official download and package-local extraction.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

export const GWS_VERSION = "0.22.5";

const DOWNLOAD_TIMEOUT_MILLISECONDS = 120_000;
const GWS_PACKAGE_DIRECTORY = resolve("node_modules/@googleworkspace/cli");
const GWS_RELEASE_ASSET_API_BASE_URL =
  "https://api.github.com/repos/googleworkspace/cli/releases/assets";
const execFileAsync = promisify(execFile);

interface GoogleWorkspaceCliArtifact {
  archiveName: string;
  releaseAssetId: number;
  sha256: string;
}

const LINUX_ARTIFACTS: Readonly<Record<string, GoogleWorkspaceCliArtifact>> = {
  arm64: {
    archiveName: "google-workspace-cli-aarch64-unknown-linux-musl.tar.gz",
    releaseAssetId: 385726968,
    sha256: "e700fe63524932b10ec2130b47ece90aa850e66005fe52ccfc4cf8767bf9919a",
  },
  x64: {
    archiveName: "google-workspace-cli-x86_64-unknown-linux-musl.tar.gz",
    releaseAssetId: 385726987,
    sha256: "4db473dde4b1ab872e4ff35d769b0d4af1f1a6441a605e79d5cf8ada9c87e920",
  },
};

export function resolveGoogleWorkspaceCliArtifact(
  platform: string,
  architecture: string,
): GoogleWorkspaceCliArtifact {
  const artifact = platform === "linux" ? LINUX_ARTIFACTS[architecture] : undefined;
  if (!artifact) {
    throw new Error(
      `AGENT_GWS_PLATFORM_UNSUPPORTED: Unsupported gws target ${platform}/${architecture}`,
    );
  }
  return artifact;
}

export function resolveGoogleWorkspaceCliDownloadUrl(
  artifact: GoogleWorkspaceCliArtifact,
): string {
  return `${GWS_RELEASE_ASSET_API_BASE_URL}/${artifact.releaseAssetId}`;
}

async function downloadVerifiedArchive(artifact: GoogleWorkspaceCliArtifact): Promise<Buffer> {
  const response = await fetch(resolveGoogleWorkspaceCliDownloadUrl(artifact), {
    headers: {
      Accept: "application/octet-stream",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MILLISECONDS),
  });
  if (!response.ok) {
    throw new Error(
      `AGENT_GWS_DOWNLOAD_FAILED: Official release returned HTTP ${response.status} for gws ${GWS_VERSION}`,
    );
  }
  const archive = Buffer.from(await response.arrayBuffer());
  const actualHash = createHash("sha256").update(archive).digest("hex");
  if (actualHash !== artifact.sha256) {
    throw new Error(
      `AGENT_GWS_CHECKSUM_MISMATCH: Expected ${artifact.sha256}, received ${actualHash}`,
    );
  }
  return archive;
}

export async function installGoogleWorkspaceCli(): Promise<void> {
  const artifact = resolveGoogleWorkspaceCliArtifact(process.platform, process.arch);
  const packageManifest = JSON.parse(
    await readFile(join(GWS_PACKAGE_DIRECTORY, "package.json"), "utf8"),
  ) as { version?: unknown };
  if (packageManifest.version !== GWS_VERSION) {
    throw new Error(
      `AGENT_GWS_VERSION_MISMATCH: Expected npm package ${GWS_VERSION}, received ${String(packageManifest.version)}`,
    );
  }

  const installDirectory = join(GWS_PACKAGE_DIRECTORY, "bin");
  const binaryPath = join(installDirectory, "gws");
  const versionPath = join(installDirectory, ".version");
  const installationMarker = `${GWS_VERSION}:${artifact.archiveName}`;
  try {
    const installedVersion = (await readFile(versionPath, "utf8")).trim();
    await access(binaryPath);
    if (installedVersion === installationMarker) return;
  } catch {
    // A clean npm install has no binary; any partial directory is replaced below.
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "osinara-gws-install-"));
  const archivePath = join(temporaryDirectory, artifact.archiveName);
  try {
    const archive = await downloadVerifiedArchive(artifact);
    await writeFile(archivePath, archive, { mode: 0o600 });
    await rm(installDirectory, { force: true, recursive: true });
    await mkdir(installDirectory, { mode: 0o755, recursive: true });
    await execFileAsync("tar", ["xf", archivePath, "-C", installDirectory]);
    await access(binaryPath);
    await chmod(binaryPath, 0o755);
    await writeFile(versionPath, `${installationMarker}\n`, { mode: 0o644 });
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  await installGoogleWorkspaceCli();
}
