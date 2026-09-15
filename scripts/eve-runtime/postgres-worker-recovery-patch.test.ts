/** Installed-artifact contract for the Graphile worker recovery patch; the real behavior runs in the integration test. */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const MAIN = "node_modules/graphile-worker/dist/main.js";
const LIB = "node_modules/graphile-worker/dist/lib.js";

describe("Graphile worker recovery patch", () => {
  it("pins the reviewed graphile-worker release", async () => {
    const pkg = JSON.parse(await readFile("node_modules/graphile-worker/package.json", "utf8")) as { version: string };
    expect(pkg.version).toBe("0.16.6");
  });

  it("replaces a worker that died with its connection after unlocking only its own job", async () => {
    const main = await readFile(MAIN, "utf8");
    expect(main).not.toContain("TODO: handle when a worker shuts down");
    expect(main).toContain("const spawnWorker = () => {");
    expect(main).toContain("for (let i = 0; i < concurrency; i++) spawnWorker();");
    expect(main).toContain("force_unlock_workers($1::text[]);`, [[worker.workerId]]");
    expect(main).toContain("AGENT_WORKFLOW_WORKER_RECOVERING");
    expect(main).toContain("AGENT_WORKFLOW_WORKER_RECOVERY_FAILED");
    // Any other worker failure keeps Graphile's native logging and is not respawned.
    expect(main).toContain("logger.error(`Worker exited with error: ${error}`, { error });");
    await expect(execFileAsync(process.execPath, ["--check", MAIN])).resolves.toBeDefined();
  });

  it("lets Graphile's own bounded retry policy cover a dropped PostgreSQL connection", async () => {
    const lib = await readFile(LIB, "utf8");
    for (const code of ["ECONNREFUSED", "ECONNRESET", "57P01", "57P02", "08006"]) {
      expect(lib).toContain(`{ code: "${code}", backoffMS: 1000 }`);
    }
    expect(lib).toContain("'Connection terminated unexpectedly'");
    await expect(execFileAsync(process.execPath, ["--check", LIB])).resolves.toBeDefined();
  });
});
