/** Installed-artifact contract for the Postgres World queue transport patch. */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const DIST = "node_modules/@workflow/world-postgres/dist";

describe("Postgres World queue transport patch", () => {
  it("sends flow requests through the bounded workflow HTTP client and closes it", async () => {
    const queue = await readFile(`${DIST}/queue.js`, "utf8");
    expect(queue).toContain("import { createWorkflowHttpClient, createWorkflowExecutionFence } from './osinara-workflow-transport.js';");
    expect(queue).toContain("const response = await httpClient.fetch(createWorkflowUrl(baseUrl, { type: 'flow' }), {");
    expect(queue).not.toContain("await fetch(createWorkflowUrl(");
    expect(queue).toContain("await httpClient.close();\n            await localWorld.close?.();");
    await expect(execFileAsync(process.execPath, ["--check", `${DIST}/queue.js`])).resolves.toBeDefined();
  });

  it("fences the receiving queue handler and no longer queues workflow replays behind a running request", async () => {
    const queue = await readFile(`${DIST}/queue.js`, "utf8");
    expect(queue).toContain("const createQueueHandler = (prefix, handler) => localWorld.createQueueHandler(prefix, fence(handler));");
    expect(queue).not.toContain("inflightWorkflowRuns");
    expect(queue).not.toContain("WorkflowInvokePayloadSchema");
    // Idempotency-keyed deliveries keep the package's own in-flight and completed caches.
    expect(queue).toContain("const existing = inflightMessages.get(idempotencyKey);");
  });

  it("installs a runtime module that resolves its dependencies from the world package", async () => {
    const runtime = await import(pathToFileURL(resolve(`${DIST}/osinara-workflow-transport.js`)).href) as typeof import("./workflow-transport.js");
    expect(runtime.WORKFLOW_HTTP_TIMEOUT_MS).toBe(35 * 60 * 1000);
    const client = runtime.createWorkflowHttpClient();
    await client.close();
  });
});
