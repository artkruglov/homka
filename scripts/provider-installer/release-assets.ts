/**
 * Immutable installation bundle resolver.
 *
 * Exports:
 * - `ReleaseAssetsResolverDependencies`: embedded build metadata and bounded fetch dependencies.
 * - `createReleaseAssetsResolver`: downloads the exact installation bundle encoded in the CLI.
 *
 * Key constructs:
 * - Fixed canonical GitHub repository, tag, and asset name.
 * - Bounded response size and timeout before bytes cross the installer trust boundary.
 */
import type { ReleaseAssets } from "./contracts.js";
import { InstallerError } from "./errors.js";

const GITHUB_RELEASES_URL = "https://github.com/nyxandro/osinara/releases/download";
const INSTALLATION_ARCHIVE_NAME = "osinara-installation.tar.gz";
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_TIMEOUT_MS = 120_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const STABLE_SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;

export interface ReleaseAssetsResolverDependencies {
  readonly archiveSha256: string;
  readonly fetch: typeof globalThis.fetch;
  readonly timeoutMs: number;
  readonly version: string;
}

/** Reads a streaming body with an exact upper bound even when Content-Length is absent or false. */
async function readBoundedArchive(response: Response): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 1 || length > MAX_ARCHIVE_BYTES) {
      throw new InstallerError(
        "OSINARA_INSTALL_RELEASE_ARCHIVE_TOO_LARGE",
        `Installation bundle должен иметь размер от 1 до ${MAX_ARCHIVE_BYTES} байт`,
      );
    }
  }
  if (!response.body) {
    throw new InstallerError(
      "OSINARA_INSTALL_RELEASE_ARCHIVE_INVALID",
      "GitHub Release не вернул обязательные байты installation bundle",
    );
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_ARCHIVE_BYTES) {
      await reader.cancel();
      throw new InstallerError(
        "OSINARA_INSTALL_RELEASE_ARCHIVE_TOO_LARGE",
        `Installation bundle превышает допустимые ${MAX_ARCHIVE_BYTES} байт`,
      );
    }
    chunks.push(value);
  }
  if (totalBytes === 0) {
    throw new InstallerError(
      "OSINARA_INSTALL_RELEASE_ARCHIVE_INVALID",
      "GitHub Release вернул пустой installation bundle",
    );
  }

  const archive = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return archive;
}

/** Creates a resolver whose version and expected hash are immutable build inputs of the SEA CLI. */
export function createReleaseAssetsResolver(
  dependencies: ReleaseAssetsResolverDependencies,
): () => Promise<ReleaseAssets> {
  return async () => {
    if (
      !STABLE_SEMVER_PATTERN.test(dependencies.version)
      || !SHA256_PATTERN.test(dependencies.archiveSha256)
    ) {
      throw new InstallerError(
        "OSINARA_INSTALL_RELEASE_METADATA_INVALID",
        "В установщик встроена некорректная версия или SHA-256 installation bundle",
      );
    }
    if (
      !Number.isInteger(dependencies.timeoutMs)
      || dependencies.timeoutMs < 1
      || dependencies.timeoutMs > MAX_TIMEOUT_MS
    ) {
      throw new InstallerError(
        "OSINARA_INSTALL_RELEASE_TIMEOUT_INVALID",
        `Таймаут загрузки release должен быть целым числом от 1 до ${MAX_TIMEOUT_MS} мс`,
      );
    }

    const url = `${GITHUB_RELEASES_URL}/v${dependencies.version}/${INSTALLATION_ARCHIVE_NAME}`;
    try {
      const response = await dependencies.fetch(url, {
        headers: { Accept: "application/octet-stream" },
        signal: AbortSignal.timeout(dependencies.timeoutMs),
      });
      if (!response.ok) {
        throw new InstallerError(
          "OSINARA_INSTALL_RELEASE_DOWNLOAD_FAILED",
          `GitHub Release отклонил загрузку installation bundle Osinara v${dependencies.version}`,
        );
      }
      return {
        archive: await readBoundedArchive(response),
        archiveSha256: dependencies.archiveSha256,
        version: dependencies.version,
      };
    } catch (error) {
      if (error instanceof InstallerError) throw error;
      throw new InstallerError(
        "OSINARA_INSTALL_RELEASE_DOWNLOAD_FAILED",
        `Не удалось загрузить installation bundle Osinara v${dependencies.version}. Проверьте сеть и повторите операцию`,
        { cause: error },
      );
    }
  };
}
