/** Real Graphile workers: recover only a dead worker's lease while another task stays live. */
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool, type PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

const suite = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;
suite("native Graphile worker replacement", () => {
  it.each(["transient", "completion-exhausted", "unlock-exhausted"])("handles %s without prematurely releasing a live task", async (mode) => {
    const exhausted = mode !== "transient";
    const url = process.env.DATABASE_URL;
    if (!url || !new URL(url).pathname.endsWith("_test")) throw new Error("AGENT_TEST_DATABASE_UNSAFE");
    const { run, makeWorkerUtils } = await import(pathToFileURL(resolve("node_modules/graphile-worker/dist/index.js")).href);
    const schema = `recovery_${crypto.randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: url, max: 4 });
    let injected = false;
    let unlockInterrupted = false;
    const unlocked: string[][] = [];
    pool.on("connect", (client) => {
      const query = client.query.bind(client);
      client.query = ((...args: unknown[]) => {
        const request = args[0] as { name?: string; text?: string } | string;
        // Only the completion of the recovery job loses its connection; the live job never completes here.
        if (typeof request === "object" && request.name?.startsWith("complete_job/") && !injected) {
          injected = true;
          return Promise.reject(new Error("Connection terminated unexpectedly"));
        }
        if (typeof request === "string" && request.includes("force_unlock_workers")) {
          unlocked.push((args[1] as string[][])[0]!);
          if (!unlockInterrupted) {
            unlockInterrupted = true;
            return Promise.reject(new Error("Client has encountered a connection error and is not queryable"));
          }
        }
        return Reflect.apply(query, client, args);
      }) as PoolClient["query"];
    });
    const events = new EventEmitter();
    let graphilePool: { _shuttingDown: boolean } | undefined;
    const stopped: string[] = [];
    const wrapped = new WeakSet<object>();
    events.on("worker:create", ({ worker }) => {
      graphilePool = worker.workerPool;
      if (!exhausted) return;
      const withClient = worker.workerPool._withPgClient;
      if (wrapped.has(withClient)) return;
      wrapped.add(withClient);
      const retry = withClient.withRetries.bind(withClient);
      // Exercise fatal-release recovery without waiting for 100 native backoff intervals: the injected
      // completion skips its retry budget; unlock keeps native retries unless unlock itself is exhausted.
      withClient.withRetries = (operation: unknown) => injected && mode !== "unlock-exhausted" ? retry(operation) : withClient(operation);
    });
    events.on("worker:stop", ({ worker, error }) => { if (error) stopped.push(worker.workerId); });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const trace = vi.spyOn(console, "trace").mockImplementation(() => undefined);
    const utils = await makeWorkerUtils({ pgPool: pool, schema });
    let releaseLive!: () => void;
    const live = new Promise<void>((done) => { releaseLive = done; });
    const task = vi.fn(async () => {});
    const liveTask = vi.fn(async () => { await live; });
    let runner: { stop(): Promise<void> } | undefined;
    try {
      await utils.migrate();
      runner = await run({ pgPool: pool, schema, concurrency: 2, noHandleSignals: true, pollInterval: 50, events,
        taskList: { recovery_task: task, live_task: liveTask } });
      await utils.addJob("live_task", {}, { jobKey: "live" });
      await vi.waitFor(() => expect(liveTask).toHaveBeenCalledOnce());
      await utils.addJob("recovery_task", {}, { jobKey: "recover" });
      if (mode === "unlock-exhausted") {
        await vi.waitFor(() => expect(graphilePool?._shuttingDown).toBe(true), { timeout: 10_000 });
        expect(task).toHaveBeenCalledOnce();
      } else {
        await vi.waitFor(async () => {
          expect(task).toHaveBeenCalledTimes(exhausted ? 2 : 1);
          expect((await pool.query(`SELECT 1 FROM "${schema}"._private_jobs WHERE key='recover'`)).rowCount).toBe(0);
        }, { timeout: 10_000 });
      }
      expect(stopped).toHaveLength(exhausted ? 1 : 0);
      expect(unlocked).toEqual(mode === "unlock-exhausted" ? [[stopped[0]]] : exhausted ? [[stopped[0]], [stopped[0]]] : []);
      const codes = log.mock.calls.map(([line]) => { try { return JSON.parse(String(line)).code; } catch { return null; } });
      if (exhausted) expect(codes).toContain("AGENT_WORKFLOW_WORKER_RECOVERING");
      if (mode === "completion-exhausted") expect(codes).toContain("AGENT_WORKFLOW_WORKER_RECOVERED");
      if (mode === "unlock-exhausted") expect(codes).toContain("AGENT_WORKFLOW_WORKER_RECOVERY_FAILED");
      // The unrelated long task keeps its own lease: recovery unlocks only the dead worker.
      const held = await pool.query(`SELECT locked_by FROM "${schema}"._private_jobs WHERE key='live'`);
      expect(held.rows).toHaveLength(1);
      expect(held.rows[0].locked_by).not.toBe(stopped[0]);
      expect(held.rows[0].locked_by).not.toBeNull();
      expect(liveTask).toHaveBeenCalledOnce();
    } finally {
      releaseLive();
      try { await runner?.stop(); }
      catch (error) { if (!(error instanceof Error) || error.message !== "Runner is already stopped") throw error; }
      await utils.release();
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      await pool.end();
      log.mockRestore();
      trace.mockRestore();
    }
  }, 20_000);
});
