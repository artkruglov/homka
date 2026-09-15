/**
 * Strict production host process and deployment-manifest contracts.
 *
 * Exports:
 * - `releaseEnvironmentFromManifest`: validates schema v1 and emits five fresh-install image refs.
 * - `parseBootstrapProcessOutput`: validates one machine-readable bootstrap process result.
 */
import { z } from "zod";

import type { InstallationExecutionResult } from "./contracts.js";
import { InstallerError } from "./errors.js";

const IMAGE_DIGEST = "[0-9a-f]{64}";
const manifestSchema = z.object({
  commitSha: z.string().regex(/^[0-9a-f]{40}$/u),
  composeSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  images: z.object({
    app: z.string().regex(new RegExp(`^ghcr\\.io/nyxandro/osinara-app@sha256:${IMAGE_DIGEST}$`, "u")),
    cliProxy: z.string().regex(
      new RegExp(`^ghcr\\.io/nyxandro/osinara-cli-proxy@sha256:${IMAGE_DIGEST}$`, "u"),
    ),
    edge: z.string().regex(new RegExp(`^ghcr\\.io/nyxandro/osinara-edge@sha256:${IMAGE_DIGEST}$`, "u")),
    sandboxEgressProxy: z.string().regex(
      new RegExp(`^ghcr\\.io/nyxandro/osinara-sandbox-egress-proxy@sha256:${IMAGE_DIGEST}$`, "u"),
    ),
    sandboxRunner: z.string().regex(
      new RegExp(`^ghcr\\.io/nyxandro/osinara-sandbox-runner@sha256:${IMAGE_DIGEST}$`, "u"),
    ),
    sandboxRuntime: z.string().regex(
      new RegExp(`^ghcr\\.io/nyxandro/osinara-sandbox-runtime@sha256:${IMAGE_DIGEST}$`, "u"),
    ),
  }).strict(),
  schemaVersion: z.literal(1),
  version: z.string().regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u),
}).strict();

const bootstrapSchema = z.object({
  bootstrapCode: z.string().regex(/^[A-Za-z0-9_-]+$/u),
  bootstrapExpiresAt: z.iso.datetime({ offset: false }),
}).strict();

export function releaseEnvironmentFromManifest(
  bytes: Buffer,
  expectedVersion: string,
): Buffer {
  try {
    const manifest = manifestSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (manifest.version !== expectedVersion) throw new Error("release version mismatch");
    return Buffer.from([
      `OSINARA_APP_IMAGE=${manifest.images.app}`,
      `OSINARA_EDGE_IMAGE=${manifest.images.edge}`,
      `OSINARA_SANDBOX_EGRESS_PROXY_IMAGE=${manifest.images.sandboxEgressProxy}`,
      `OSINARA_SANDBOX_RUNNER_IMAGE=${manifest.images.sandboxRunner}`,
      `SANDBOX_RUNTIME_IMAGE=${manifest.images.sandboxRuntime}`,
      "",
    ].join("\n"), "utf8");
  } catch (error) {
    throw new InstallerError(
      "OSINARA_INSTALL_MANIFEST_INVALID",
      "Installation bundle содержит некорректный deployment manifest",
      { cause: error },
    );
  }
}

export function parseBootstrapProcessOutput(bytes: Buffer): InstallationExecutionResult {
  try {
    return bootstrapSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    throw new InstallerError(
      "OSINARA_INSTALL_BOOTSTRAP_OUTPUT_INVALID",
      "Контейнер не вернул корректный одноразовый код владельца",
      { cause: error },
    );
  }
}
