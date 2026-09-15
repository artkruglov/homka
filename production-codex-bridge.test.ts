/**
 * One-time v0.16.0 Codex subscription production bridge tests.
 *
 * Constructs covered:
 * - `provision_v0160_codex_bridge`: validates staged OAuth and seeds the candidate durable volume.
 * - The bridge atomically installs the reviewed model config and reuses the internal proxy key.
 * - Provisioning starts only after current data is backed up and the migration boundary is crossed.
 * - Promotion requires one real medium-reasoning Luna completion through the candidate gateway.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("./", import.meta.url));
const temporaryDirectories: string[] = [];
const productionSourceConfig = Buffer.from(`{
  "agent": {
    "models": {
      "primary": {
        "contextWindowTokens": 262144,
        "id": "qwen3.8-27b",
        "maxOutputTokens": 16384
      },
      "vision": {
        "id": "qwen3.8-27b",
        "maxOutputTokens": 16384,
        "supportsImageInput": true
      }
    },
    "transport": {
      "baseUrl": "https://api.neuraldeep.ru/v1",
      "protocol": "openai-chat-completions",
      "providerName": "neuraldeep",
      "reasoning": null
    }
  },
  "provider": "neuraldeep",
  "schemaVersion": 4,
  "voice": {
    "enabled": true,
    "transcriptionModelId": "whisper-large-v3-turbo"
  }
}
`);

function runBridge(directory: string, sourceVersion = "0.15.14", initialMode = false) {
  const current = join(directory, "current");
  const work = join(directory, "work");
  const authVolume = join(directory, "auth-volume");
  mkdirSync(current, { recursive: true });
  mkdirSync(work, { recursive: true });
  mkdirSync(authVolume, { recursive: true });
  if (!initialMode) writeFileSync(join(authVolume, ".created"), "");
  writeFileSync(join(current, "osinara-deployment.json"), JSON.stringify({ version: sourceVersion }));
  writeFileSync(
    join(directory, "agent-model-providers.json"),
    initialMode
      ? readFileSync(join(projectRoot, "scripts/production-deploy/fixtures/v0152-model-providers.json"))
      : productionSourceConfig,
  );
  writeFileSync(
    join(work, "codex-subscription-model-providers.json"),
    readFileSync(join(projectRoot, "config/codex-subscription-model-providers.json")),
  );

  return spawnSync("/bin/bash", ["-c", `
    set -euo pipefail
    fail() { printf '%s\n' "$1" >&2; return 1; }
    require_metadata() { return 0; }
    install() { command cp "\${@: -2}"; }
    docker() {
      if [[ "$1 $2" == "volume inspect" ]]; then
        [[ -f "$AUTH_VOLUME_DIR/.created" ]]
        return
      fi
      if [[ "$1 $2" == "volume create" ]]; then
        command touch "$AUTH_VOLUME_DIR/.created"
        return 0
      fi
      if [[ "$1" == "run" ]]; then
        command rm -f "$AUTH_VOLUME_DIR/.created"
        command cp "$CODEX_AUTH_SEED" "$AUTH_VOLUME_DIR/opencode-codex.json"
        command chmod 0600 "$AUTH_VOLUME_DIR/opencode-codex.json"
        return 0
      fi
      return 1
    }
    BASE_DIR=${JSON.stringify(directory)}
    SERVER_ENV=${JSON.stringify(join(directory, ".env"))}
    AGENT_MODEL_PROVIDER_CONFIG=${JSON.stringify(join(directory, "agent-model-providers.json"))}
    CODEX_AUTH_SEED=${JSON.stringify(join(directory, "codex-auth.json"))}
    CODEX_AUTH_VOLUME=osinara-production-cli-proxy-auth
    AUTH_VOLUME_DIR=${JSON.stringify(authVolume)}
    CURRENT_LINK=${JSON.stringify(current)}
    WORK_DIR=${JSON.stringify(work)}
    APP_IMAGE=test-app-image
    CREATED_CANDIDATE_VOLUMES=()
    INITIAL_MODE=${initialMode ? 1 : 0}
    PROCESS_MODEL_KEY_PATH=${JSON.stringify(join(directory, "process-model-key"))}
    REQUESTED_VERSION=0.16.0
    export MODEL_API_KEY=stale-process-model-key
    source scripts/production-deploy/bridge.sh
    prepare_v0160_codex_volume
    provision_v0160_codex_bridge
    printf %s "$MODEL_API_KEY" > "$PROCESS_MODEL_KEY_PATH"
  `], { cwd: projectRoot, encoding: "utf8" });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("v0.16.0 Codex subscription bridge", () => {
  it("installs exact config, persistent OAuth, and the existing internal proxy key", () => {
    const directory = mkdtempSync(join(tmpdir(), "osinara-v0160-codex-"));
    temporaryDirectories.push(directory);
    writeFileSync(
      join(directory, ".env"),
      "DEEPSEEK_API_KEY='rollback-key'\nMODEL_API_KEY='active-neuraldeep-key'\nCLI_PROXY_API_KEY='internal-key'\n",
    );
    writeFileSync(join(directory, "codex-auth.json"), JSON.stringify({
      access_token: "access-token",
      account_id: "00000000-0000-4000-8000-000000000001",
      expired: "2026-08-28T05:59:46Z",
      refresh_token: "refresh-token",
      type: "codex",
    }), { mode: 0o600 });

    const result = runBridge(directory);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(directory, "agent-model-providers.json"))).toEqual(
      readFileSync(join(projectRoot, "config/codex-subscription-model-providers.json")),
    );
    expect(readFileSync(join(directory, "auth-volume/opencode-codex.json"), "utf8")).toContain(
      '"type":"codex"',
    );
    expect(readFileSync(join(directory, ".env"), "utf8")).toBe(
      "DEEPSEEK_API_KEY='rollback-key'\nMODEL_API_KEY='internal-key'\nCLI_PROXY_API_KEY='internal-key'\n",
    );
    expect(readFileSync(join(directory, "process-model-key"), "utf8")).toBe("internal-key");
  });

  it("rejects malformed OAuth before changing model configuration", () => {
    const directory = mkdtempSync(join(tmpdir(), "osinara-v0160-codex-invalid-"));
    temporaryDirectories.push(directory);
    writeFileSync(
      join(directory, ".env"),
      "DEEPSEEK_API_KEY=rollback-key\nMODEL_API_KEY=active-neuraldeep-key\nCLI_PROXY_API_KEY=internal-key\n",
    );
    writeFileSync(join(directory, "codex-auth.json"), JSON.stringify({ type: "codex" }), {
      mode: 0o600,
    });

    const result = runBridge(directory);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DEPLOY_V0160_CODEX_AUTH_INVALID");
    expect(readFileSync(join(directory, "agent-model-providers.json"))).toEqual(
      productionSourceConfig,
    );
  });

  it("crosses the irreversible boundary only after backup and before Codex provisioning", () => {
    const deployment = readFileSync(join(projectRoot, "scripts/production-deploy.sh"), "utf8");
    const validation = deployment.indexOf("validate_v0160_codex_bridge");
    const candidatePreparation = deployment.indexOf("prepare_candidate_release");
    const volumePreparation = deployment.indexOf("prepare_v0160_codex_volume");
    const snapshot = deployment.indexOf("snapshot_durable_volumes");
    const migration = deployment.indexOf("MIGRATION_STARTED=1", snapshot);
    const provisioning = deployment.indexOf("provision_v0160_codex_bridge", migration);
    const candidate = deployment.indexOf("start_candidate_release", provisioning);
    const smoke = deployment.indexOf("validate_v0160_codex_model", candidate);
    const promotion = deployment.indexOf("promote_candidate_release", smoke);

    expect(validation).toBeGreaterThanOrEqual(0);
    expect(candidatePreparation).toBeGreaterThan(validation);
    expect(volumePreparation).toBeGreaterThan(candidatePreparation);
    expect(migration).toBeGreaterThan(volumePreparation);
    expect(snapshot).toBeGreaterThan(candidatePreparation);
    expect(migration).toBeGreaterThan(snapshot);
    expect(provisioning).toBeGreaterThan(migration);
    expect(candidate).toBeGreaterThan(provisioning);
    expect(smoke).toBeGreaterThan(candidate);
    expect(promotion).toBeGreaterThan(smoke);
  });

  it("defines a bounded no-retry completion smoke for the exact production model", () => {
    const bridge = readFileSync(join(projectRoot, "scripts/production-deploy/bridge.sh"), "utf8");

    expect(bridge).toContain('"model":"gpt-5.6-luna"');
    expect(bridge).toContain('"reasoning_effort":"medium"');
    expect(bridge).toContain("--max-time 120");
    expect(bridge).toContain("DEPLOY_V0160_CODEX_MODEL_SMOKE_FAILED");
  });

  it("rejects a source release other than the exact production predecessor", () => {
    const directory = mkdtempSync(join(tmpdir(), "osinara-v0160-codex-source-"));
    temporaryDirectories.push(directory);
    writeFileSync(
      join(directory, ".env"),
      "DEEPSEEK_API_KEY=rollback-key\nMODEL_API_KEY=active-neuraldeep-key\nCLI_PROXY_API_KEY=internal-key\n",
    );
    writeFileSync(join(directory, "codex-auth.json"), JSON.stringify({
      access_token: "access-token",
      account_id: "00000000-0000-4000-8000-000000000001",
      expired: "2026-08-28T05:59:46Z",
      refresh_token: "refresh-token",
      type: "codex",
    }), { mode: 0o600 });

    const result = runBridge(directory, "0.15.13");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DEPLOY_V0160_BRIDGE_SOURCE_INVALID");
  });

  it("provisions initial controller deployments without a legacy DeepSeek assignment", () => {
    const directory = mkdtempSync(join(tmpdir(), "osinara-v0160-codex-initial-"));
    temporaryDirectories.push(directory);
    writeFileSync(
      join(directory, ".env"),
      "MODEL_API_KEY='direct-provider-key'\nCLI_PROXY_API_KEY='internal-key'\n",
    );
    writeFileSync(join(directory, "codex-auth.json"), JSON.stringify({
      access_token: "access-token",
      account_id: "00000000-0000-4000-8000-000000000001",
      expired: "2026-08-28T05:59:46Z",
      refresh_token: "refresh-token",
      type: "codex",
    }), { mode: 0o600 });

    const result = runBridge(directory, "unused-for-initial", true);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(directory, ".env"), "utf8")).toBe(
      "MODEL_API_KEY='internal-key'\nCLI_PROXY_API_KEY='internal-key'\n",
    );
    expect(readFileSync(join(directory, "process-model-key"), "utf8")).toBe("internal-key");
  });

  it("sets secure ownership and mode on the named volume root", () => {
    const bridge = readFileSync(join(projectRoot, "scripts/production-deploy/bridge.sh"), "utf8");

    expect(bridge).toContain("chown 10001:10001 /auth");
    expect(bridge).toContain("chmod 0700 /auth");
  });

  it("pins the exact current production NeuralDeep source bytes", () => {
    expect(createHash("sha256").update(productionSourceConfig).digest("hex")).toBe(
      "3ebc69be3aec08cae7a08ce4024b6b8d8a00a797819a787aed391b8ee30937dd",
    );
  });
});
