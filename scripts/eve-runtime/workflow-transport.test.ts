/** Transport reconnection cannot start a second live execution of the same durable delivery. */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorkflowExecutionFence, createWorkflowHttpClient, WORKFLOW_HTTP_TIMEOUT_MS } from "./workflow-transport.js";

const meta = (messageId: string) => ({ messageId, queueName: "__wkf_workflow_test", attempt: 1 }) as never;

describe("workflow execution fence", () => {
  it("shares live redelivery after a client disconnect, but permits a later durable reschedule", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const execute = vi.fn(async () => { await pending; return { timeoutSeconds: 1 }; });
    const handler = createWorkflowExecutionFence()(execute);
    const first = handler({ runId: "run" }, meta("message"));
    const second = handler({ runId: "run" }, { ...meta("message") as object, attempt: 2 } as never);
    await Promise.resolve();
    expect(execute).toHaveBeenCalledOnce();
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({ code: "AGENT_WORKFLOW_EXECUTION_JOINED", attempt: 2 });
    finish();
    await expect(first).resolves.toEqual({ timeoutSeconds: 1 });
    await expect(second).resolves.toEqual({ timeoutSeconds: 1 });
    await handler({ runId: "run" }, meta("message"));
    expect(execute).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("admits workflow replays while an inline step is running, without duplicating a delivery", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const seen: string[] = [];
    const handler = createWorkflowExecutionFence()(async (_payload, delivery) => {
      seen.push(delivery.messageId);
      if (delivery.messageId === "first") await pending;
    });
    const first = handler({ runId: "run" }, meta("first"));
    const next = handler({ runId: "run", requestedAt: new Date() }, meta("next"));
    const replay = handler({ runId: "run" }, meta("first"));
    await handler({ runId: "run", stepId: "step" }, meta("step"));
    await handler({ runId: "other" }, meta("other"));
    expect(seen).toEqual(["first", "next", "step", "other"]);
    finish(); await Promise.all([first, next, replay]);
    expect(seen).toEqual(["first", "next", "step", "other"]);
    warn.mockRestore();
  });

  it("serializes distinct deliveries of the same explicit step", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const seen: string[] = [];
    const handler = createWorkflowExecutionFence()(async (_payload, delivery) => {
      seen.push(delivery.messageId);
      if (delivery.messageId === "first") await pending;
    });
    const first = handler({ runId: "run", stepId: "step" }, meta("first"));
    const second = handler({ runId: "run", stepId: "step" }, meta("second"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual(["first"]);
    finish(); await Promise.all([first, second]);
    expect(seen).toEqual(["first", "second"]);
  });

  it("rejects reuse of a live message ID with different bytes", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const handler = createWorkflowExecutionFence()(async () => pending);
    const first = handler({ runId: "run" }, meta("message"));
    await expect(handler({ runId: "foreign" }, meta("message"))).rejects.toThrow("AGENT_WORKFLOW_DELIVERY_CONFLICT");
    finish(); await first;
  });

  it("preserves handler failure for all waiters and releases the next distinct delivery", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failure = new Error("execution failed");
    const execute = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    const handler = createWorkflowExecutionFence()(execute);
    const first = handler({ runId: "run" }, meta("first"));
    const replay = handler({ runId: "run" }, meta("first"));
    const next = handler({ runId: "run" }, meta("next"));
    await expect(first).rejects.toBe(failure);
    await expect(replay).rejects.toBe(failure);
    await next;
    expect(execute).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("does not start a queued step delivery once shutdown begins", async () => {
    let closing = false, finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const execute = vi.fn(async () => gate);
    const handler = createWorkflowExecutionFence(() => closing)(execute);
    const first = handler({ runId: "run", stepId: "step" }, meta("first"));
    const next = handler({ runId: "run", stepId: "step" }, meta("next"));
    await Promise.resolve(); closing = true; finish();
    await first;
    await expect(next).rejects.toThrow("AGENT_WORKFLOW_SHUTTING_DOWN");
    expect(execute).toHaveBeenCalledOnce();
  });
});

describe("workflow HTTP client", () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    server = undefined;
  });

  async function slowExecutor(delayMilliseconds: number): Promise<string> {
    server = createServer((_request, response) => {
      setTimeout(() => response.writeHead(200, { "content-type": "application/json" }).end("{\"ok\":true}"), delayMilliseconds);
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/`;
  }

  it("keeps a flow request open far beyond Node's default 300-second header deadline", () => {
    expect(WORKFLOW_HTTP_TIMEOUT_MS).toBeGreaterThan(30 * 60 * 1000);
  });

  it("waits for a slow executor within its own window and reports a transport failure with a stable code", async () => {
    const url = await slowExecutor(1_500);
    const patient = createWorkflowHttpClient(5_000);
    try {
      const response = await patient.fetch(url, { method: "POST", body: "{}" });
      expect(await response.json()).toEqual({ ok: true });
    } finally { await patient.close(); }

    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const impatient = createWorkflowHttpClient(100);
    try {
      await expect(impatient.fetch(url, { method: "POST", body: "{}" })).rejects.toThrow();
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
        code: "AGENT_WORKFLOW_TRANSPORT_FAILED",
        errorName: "TypeError",
        causeCode: "UND_ERR_HEADERS_TIMEOUT",
      });
    } finally {
      await impatient.close();
      log.mockRestore();
    }
  }, 15_000);
});
