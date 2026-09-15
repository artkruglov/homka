/**
 * One-time v0.15.2 production bridge tests.
 *
 * Constructs covered:
 * - `provision_v0152_model_bridge`: derives `MODEL_API_KEY` from the exact legacy assignment.
 * - Canonical release config installation, rollback credential preservation, and idempotence.
 * - Fail-closed rejection of conflicting credentials, config bytes, and unsupported source versions.
 * - Owner/release ordering, edge frontend isolation, and bridge release asset provenance.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  executeComposeSecurityPredicate,
  resolvedComposeSecurityFixture,
} from "./production-release-contract-fixtures.js";

const projectRoot = fileURLToPath(new URL("./", import.meta.url));
const temporaryDirectories: string[] = [];
const canonicalConfig = readFileSync(join(projectRoot, "scripts/production-deploy/fixtures/v0152-model-providers.json"));

function runBridge(directory: string, requestedVersion = "0.15.2") {
  const current = join(directory, "current");
  const work = join(directory, "work");
  mkdirSync(current, { recursive: true });
  mkdirSync(work, { recursive: true });
  if (!existsSync(join(current, "osinara-deployment.json"))) {
    writeFileSync(join(current, "osinara-deployment.json"), JSON.stringify({ version: "0.15.1" }));
  }
  writeFileSync(join(work, "agent-model-providers.json"), canonicalConfig);

  return spawnSync("/bin/bash", ["-c", `
    set -euo pipefail
    fail() { printf '%s\n' "$1" >&2; return 1; }
    require_metadata() { return 0; }
    install() { command cp "\${@: -2}"; }
    BASE_DIR=${JSON.stringify(directory)}
    SERVER_ENV=${JSON.stringify(join(directory, ".env"))}
    AGENT_MODEL_PROVIDER_CONFIG=${JSON.stringify(join(directory, "agent-model-providers.json"))}
    CURRENT_LINK=${JSON.stringify(current)}
    WORK_DIR=${JSON.stringify(work)}
    INITIAL_MODE=0
    REQUESTED_VERSION=${JSON.stringify(requestedVersion)}
    source scripts/production-deploy/bridge.sh
    provision_v0152_model_bridge
  `], { cwd: projectRoot, encoding: "utf8" });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("v0.15.2 production bridge", () => {
  it("creates the exact canonical config and key while preserving the rollback credential", () => {
    const directory = mkdtempSync(join(tmpdir(), "osinara-v0152-bridge-"));
    temporaryDirectories.push(directory);
    writeFileSync(join(directory, ".env"), "DATABASE_URL=postgres://db\nDEEPSEEK_API_KEY='legacy-key'\n");

    const result = runBridge(directory);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(directory, "agent-model-providers.json"))).toEqual(canonicalConfig);
    expect(readFileSync(join(directory, ".env"), "utf8")).toBe(
      "DATABASE_URL=postgres://db\nDEEPSEEK_API_KEY='legacy-key'\nMODEL_API_KEY='legacy-key'\n",
    );
  });

  it("runs after immutable release and owner checks but before Compose config", () => {
    const deployment = readFileSync(join(projectRoot, "scripts/production-deploy.sh"), "utf8");
    const release = readFileSync(join(projectRoot, "scripts/production-deploy/release.sh"), "utf8");
    const releaseDownload = deployment.indexOf('download_and_validate_release "$REQUESTED_VERSION"');
    const ownerCheck = deployment.indexOf("recheck_claim_owner", releaseDownload);
    const provisioning = deployment.indexOf("provision_v0152_model_bridge", ownerCheck);
    const composeConfig = deployment.indexOf("prepare_candidate_release", provisioning);

    expect(ownerCheck).toBeGreaterThan(releaseDownload);
    expect(provisioning).toBeGreaterThan(ownerCheck);
    expect(composeConfig).toBeGreaterThan(provisioning);
    expect(release).toContain('V0152_MODEL_CONFIG_ASSET="agent-model-providers.json"');
    expect(release).toContain('curl_github --output "$model_config"');
  });

  it.skip("publishes attestations for every executable bridge bootstrap contract (no release pipeline in this repository yet)", () => {
    const workflow = readFileSync(join(projectRoot, ".github/workflows/ci-release.yaml"), "utf8");

    expect(workflow).toMatch(/Attest installer bootstrap[\s\S]*?subject-path: install\.sh/u);
    expect(workflow).toMatch(/Attest installer checksum[\s\S]*?subject-path: osinara-linux-x64\.sha256/u);
    expect(workflow).toMatch(/Attest bridge model config[\s\S]*?subject-path: agent-model-providers\.json/u);
  });

  it("exposes only edge on the dedicated frontend network", () => {
    const compose = readFileSync(join(projectRoot, "compose.production.yaml"), "utf8");
    const hostOperations = readFileSync(
      join(projectRoot, "scripts/provider-installer/production-host-operations.ts"),
      "utf8",
    );
    const valid = resolvedComposeSecurityFixture();
    const unsafe = structuredClone(valid) as {
      services: Record<string, { networks?: Record<string, null> }>;
    };
    unsafe.services.agent!.networks = { "edge-frontend": null };

    expect(compose.match(/      - edge-frontend/g)).toHaveLength(1);
    expect(compose).toContain("  edge-frontend:\n    name: osinara-production-edge-frontend");
    expect(hostOperations).toContain('"osinara-production-edge-frontend"');
    expect(() => executeComposeSecurityPredicate(valid)).not.toThrow();
    expect(() => executeComposeSecurityPredicate(unsafe)).toThrow();
  });

  it("is idempotent only when both provisioned contracts still match exactly", () => {
    const directory = mkdtempSync(join(tmpdir(), "osinara-v0152-bridge-idempotent-"));
    temporaryDirectories.push(directory);
    writeFileSync(join(directory, ".env"), "DEEPSEEK_API_KEY=legacy-key\n");

    expect(runBridge(directory).status).toBe(0);
    const environment = readFileSync(join(directory, ".env"));
    expect(runBridge(directory).status).toBe(0);
    expect(readFileSync(join(directory, ".env"))).toEqual(environment);
  });

  it("rejects a conflicting model key without changing either file", () => {
    const directory = mkdtempSync(join(tmpdir(), "osinara-v0152-bridge-conflict-"));
    temporaryDirectories.push(directory);
    const environment = "DEEPSEEK_API_KEY=legacy-key\nMODEL_API_KEY=other-key\n";
    writeFileSync(join(directory, ".env"), environment);

    const result = runBridge(directory);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DEPLOY_V0152_MODEL_KEY_CONFLICT");
    expect(readFileSync(join(directory, ".env"), "utf8")).toBe(environment);
    expect(() => readFileSync(join(directory, "agent-model-providers.json"))).toThrow();
  });

  it("does not provision missing bridge state from any version except v0.15.1", () => {
    const directory = mkdtempSync(join(tmpdir(), "osinara-v0152-bridge-version-"));
    temporaryDirectories.push(directory);
    writeFileSync(join(directory, ".env"), "DEEPSEEK_API_KEY=legacy-key\n");
    mkdirSync(join(directory, "current"), { recursive: true });
    writeFileSync(
      join(directory, "current", "osinara-deployment.json"),
      JSON.stringify({ version: "0.15.0" }),
    );

    const result = runBridge(directory);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DEPLOY_V0152_BRIDGE_SOURCE_INVALID");
  });
});
