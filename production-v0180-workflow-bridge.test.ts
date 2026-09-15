/**
 * One-time v0.18.0 PostgreSQL Workflow production bridge tests.
 *
 * Constructs covered:
 * - Exact v0.17.1 source binding and atomic environment provisioning.
 * - Idempotent retry with the same generated Workflow database credential.
 * - Fail-closed rejection of malformed, duplicate, exported, or unsupported state.
 * - Provisioning after owner/release validation and before candidate Compose interpolation.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const projectRoot = new URL("./", import.meta.url).pathname;
const temporaryDirectories: string[] = [];
const generatedPassword = "0123456789abcdef".repeat(4);
const generatedUrl =
  `postgresql://osinara_workflow:${generatedPassword}@postgres:5432/osinara_workflow`;

function runBridge(input: {
  directory: string;
  initialMode?: boolean;
  processUrl?: string;
  sourceVersion?: string;
}) {
  const current = join(input.directory, "current");
  const work = join(input.directory, "work");
  const processValue = join(input.directory, "process-workflow-url");
  mkdirSync(current, { recursive: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(
    join(current, "osinara-deployment.json"),
    JSON.stringify({ version: input.sourceVersion ?? "0.17.1" }),
  );

  return spawnSync("/bin/bash", ["-c", `
    set -euo pipefail
    fail() { printf '%s\n' "$1" >&2; return 1; }
    require_metadata() { return 0; }
    install() { command cp "\${@: -2}"; }
    openssl() {
      [[ "$*" == "rand -hex 32" ]] || return 2
      printf '%s\n' ${JSON.stringify(generatedPassword)}
    }
    BASE_DIR=${JSON.stringify(input.directory)}
    SERVER_ENV=${JSON.stringify(join(input.directory, ".env"))}
    CURRENT_LINK=${JSON.stringify(current)}
    WORK_DIR=${JSON.stringify(work)}
    INITIAL_MODE=${input.initialMode === true ? 1 : 0}
    REQUESTED_VERSION=0.18.0
    ${input.processUrl === undefined ? "unset WORKFLOW_POSTGRES_URL" : `export WORKFLOW_POSTGRES_URL=${JSON.stringify(input.processUrl)}`}
    source scripts/production-deploy/bridge.sh
    provision_v0180_workflow_postgres_bridge
    printf '%s' "$WORKFLOW_POSTGRES_URL" > ${JSON.stringify(processValue)}
  `], { cwd: projectRoot, encoding: "utf8" });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("v0.18.0 PostgreSQL Workflow bridge", () => {
  it("atomically appends and exports a dedicated connection from exact v0.17.1", () => {
    const directory = mkdtempSync(join(tmpdir(), "osinara-v0180-workflow-"));
    temporaryDirectories.push(directory);
    writeFileSync(join(directory, ".env"), "DATABASE_URL='postgresql://osinara:secret@postgres:5432/osinara'\n");

    const result = runBridge({ directory });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(directory, ".env"), "utf8")).toBe(
      "DATABASE_URL='postgresql://osinara:secret@postgres:5432/osinara'\n" +
        `WORKFLOW_POSTGRES_URL='${generatedUrl}'\n`,
    );
    expect(readFileSync(join(directory, "process-workflow-url"), "utf8")).toBe(generatedUrl);
  });

  it("reuses the exact generated connection on retry without changing the environment", () => {
    const directory = mkdtempSync(join(tmpdir(), "osinara-v0180-workflow-retry-"));
    temporaryDirectories.push(directory);
    writeFileSync(join(directory, ".env"), "MODEL_API_KEY='model-secret'\n");

    expect(runBridge({ directory }).status).toBe(0);
    const environment = readFileSync(join(directory, ".env"));
    const retry = runBridge({ directory, processUrl: generatedUrl });

    expect(retry.status, retry.stderr).toBe(0);
    expect(readFileSync(join(directory, ".env"))).toEqual(environment);
  });

  it("accepts the installer-generated connection during an initial deployment", () => {
    const directory = mkdtempSync(join(tmpdir(), "osinara-v0180-workflow-initial-"));
    temporaryDirectories.push(directory);
    writeFileSync(join(directory, ".env"), `WORKFLOW_POSTGRES_URL='${generatedUrl}'\n`);

    const result = runBridge({ directory, initialMode: true });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(directory, ".env"), "utf8")).toBe(
      `WORKFLOW_POSTGRES_URL='${generatedUrl}'\n`,
    );
  });

  it.each([
    [
      "unsupported source",
      "MODEL_API_KEY=secret\n",
      "0.17.0",
      undefined,
      "DEPLOY_V0180_BRIDGE_SOURCE_INVALID",
    ],
    [
      "duplicate assignment",
      `WORKFLOW_POSTGRES_URL='${generatedUrl}'\nWORKFLOW_POSTGRES_URL='${generatedUrl}'\n`,
      "0.17.1",
      undefined,
      "DEPLOY_V0180_WORKFLOW_URL_INVALID",
    ],
    [
      "malformed assignment",
      "WORKFLOW_POSTGRES_URL='postgresql://wrong@postgres/osinara'\n",
      "0.17.1",
      undefined,
      "DEPLOY_V0180_WORKFLOW_URL_INVALID",
    ],
    [
      "exported conflict",
      `WORKFLOW_POSTGRES_URL='${generatedUrl}'\n`,
      "0.17.1",
      "postgresql://attacker",
      "DEPLOY_V0180_WORKFLOW_URL_CONFLICT",
    ],
  ])(
    "rejects %s without changing the environment",
    (_label, environment, sourceVersion, processUrl, code) => {
      const directory = mkdtempSync(join(tmpdir(), "osinara-v0180-workflow-invalid-"));
      temporaryDirectories.push(directory);
      writeFileSync(join(directory, ".env"), environment);

      const result = runBridge({ directory, processUrl, sourceVersion });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(code);
      expect(readFileSync(join(directory, ".env"), "utf8")).toBe(environment);
    },
  );

  it("runs after immutable release and owner checks but before candidate Compose config", () => {
    const deployment = readFileSync(join(projectRoot, "scripts/production-deploy.sh"), "utf8");
    const releaseDownload = deployment.indexOf('download_and_validate_release "$REQUESTED_VERSION"');
    const ownerCheck = deployment.indexOf("recheck_claim_owner", releaseDownload);
    const bridge = deployment.indexOf("provision_v0180_workflow_postgres_bridge", ownerCheck);
    const composeConfig = deployment.indexOf("prepare_candidate_release", bridge);

    expect(ownerCheck).toBeGreaterThan(releaseDownload);
    expect(bridge).toBeGreaterThan(ownerCheck);
    expect(composeConfig).toBeGreaterThan(bridge);
  });
});
