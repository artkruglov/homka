/** Version-pinned seams: a lost PostgreSQL connection must not crash the process or strand queue work. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

type Replace = (path: string, before: string, after: string) => Promise<void>;

export async function patchPostgresConnectionRecovery(replace: Replace) {
  const world = resolve("node_modules/@workflow/world-postgres");
  const pkg = JSON.parse(await readFile(`${world}/package.json`, "utf8"));
  if (pkg.version !== "5.0.0-beta.35") throw new Error("AGENT_WORKFLOW_PATCH_VERSION_UNSUPPORTED: Expected world-postgres 5.0.0-beta.35");
  await patchStreamListenClient(replace, `${world}/dist/streamer.js`);
  const graphile = resolve("node_modules/graphile-worker");
  const graphilePkg = JSON.parse(await readFile(`${graphile}/package.json`, "utf8"));
  if (graphilePkg.version !== "0.16.6") throw new Error("AGENT_GRAPHILE_PATCH_VERSION_UNSUPPORTED: Expected graphile-worker 0.16.6");
  await patchGraphileWorkerReplacement(replace, `${graphile}/dist/main.js`);
  await patchGraphileConnectionRetries(replace, `${graphile}/dist/lib.js`);
}

// Kept local to the patch: the installed JavaScript cannot import application helpers.
const CONNECTION_CODES = "['57P01','57P02','57P03','08006','ECONNRESET','ECONNREFUSED']";
const CONNECTION_MESSAGES = "['Connection terminated unexpectedly','Connection terminated','Client has encountered a connection error and is not queryable']";

// Graphile 0.16.6 kills a worker whose completeJob/failJob query failed ("committing seppuku"), keeps
// that job locked by the dead worker id and never spawns a replacement (upstream TODO). Every
// PostgreSQL blip permanently removed a queue slot until workflow execution stopped altogether.
// The callback runs only after the worker promise settled, so its task is no longer executing:
// unlock exactly that worker's job with Graphile's own force_unlock_workers and spawn a new worker.
// If the unlock itself cannot be done, the pool shuts down instead of running with a lost slot.
async function patchGraphileWorkerReplacement(replace: Replace, main: string) {
  await replace(main, "    for (let i = 0; i < concurrency; i++) {\n        const worker = (0, worker_1.makeNewWorker)",
    "    const spawnWorker = () => {\n        const worker = (0, worker_1.makeNewWorker)");
  await replace(main, "            logger.error(`Worker exited with error: ${error}`, { error });", `            const unavailable = error && (${CONNECTION_CODES}.includes(error.code) || ${CONNECTION_MESSAGES}.includes(error.message));
            if (unavailable && continuous && workerPool._active && !workerPool._shuttingDown) {
                console.error(JSON.stringify({ code: 'AGENT_WORKFLOW_WORKER_RECOVERING', workerId: worker.workerId, databaseCode: typeof error.code === 'string' ? error.code : null }));
                withPgClient.withRetries((client) => client.query(\`select \${compiledSharedOptions.escapedWorkerSchema}.force_unlock_workers($1::text[]);\`, [[worker.workerId]]))
                    .then(() => {
                    if (workerPool._active && !workerPool._shuttingDown) {
                        spawnWorker();
                        console.error(JSON.stringify({ code: 'AGENT_WORKFLOW_WORKER_RECOVERED', workerId: worker.workerId }));
                    }
                })
                    .catch((recoveryError) => {
                    console.error(JSON.stringify({ code: 'AGENT_WORKFLOW_WORKER_RECOVERY_FAILED', workerId: worker.workerId, databaseCode: typeof recoveryError?.code === 'string' ? recoveryError.code : null }));
                    void workerPool.gracefulShutdown('AGENT_WORKFLOW_WORKER_RECOVERY_EXHAUSTED')
                        .catch((shutdownError) => logger.error(\`Worker pool shutdown failed: \${shutdownError}\`, { error: shutdownError }));
                });
            }
            else {
                logger.error(\`Worker exited with error: \${error}\`, { error });
            }`);
  await replace(main, "    }\n    // TODO: handle when a worker shuts down (spawn a new one)\n    return workerPool;",
    "    };\n    for (let i = 0; i < concurrency; i++) spawnWorker();\n    return workerPool;");
}

// completeJob/failJob already run through Graphile's bounded withRetries (100 attempts); it only
// lacked the codes and messages of a dropped connection, so a restart killed the worker at once.
async function patchGraphileConnectionRetries(replace: Replace, lib: string) {
  await replace(lib, "const RETRYABLE_ERROR_CODES = [", `const RETRYABLE_ERROR_CODES = [
    { code: "ECONNREFUSED", backoffMS: 1000 },
    { code: "ECONNRESET", backoffMS: 1000 },
    { code: "57P01", backoffMS: 1000 },
    { code: "57P02", backoffMS: 1000 },
    { code: "08006", backoffMS: 1000 },`);
  await replace(lib, "const retryable = RETRYABLE_ERROR_CODES.find(({ code }) => code === e.code);",
    `const retryable = RETRYABLE_ERROR_CODES.find(({ code }) => code === e.code || (code === '08006' && ${CONNECTION_MESSAGES}.includes(e.message)));`);
}

// The dedicated LISTEN client is created outside the pool, so no pool or Graphile listener covers it:
// a PostgreSQL restart emitted 'error' on a bare EventEmitter and Node exited. Paged stream reads
// already poll PostgreSQL (scripts/eve-runtime/paged-stream.ts), so the notification is only a
// wake-up hint and losing it degrades latency, not correctness. The listener stays attached after
// close because a dead socket can still report late.
async function patchStreamListenClient(replace: Replace, streamer: string) {
  await replace(streamer, "    const client = new Client(pool.options);", `    const client = new Client(pool.options);
    let broken = false;
    client.on('error', (error) => {
        if (broken) return;
        broken = true;
        console.error(JSON.stringify({ code: 'AGENT_WORKFLOW_NOTIFY_CONNECTION_LOST', databaseCode: typeof error?.code === 'string' ? error.code : null }));
    });`);
  await replace(streamer, "                await client.query(`UNLISTEN ${channel}`);", "                if (!broken) await client.query(`UNLISTEN ${channel}`);");
}
