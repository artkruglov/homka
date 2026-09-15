/** The LISTEN client is only a wake-up hint: its connection loss must not crash the agent process. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

async function loadInstalledStreamer() {
  // Execute the installed artifact with only its PostgreSQL socket substituted, as in
  // stream-notification.test.ts: Vitest's pg mock does not cross the world's module boundary.
  const root = resolve("node_modules/@workflow/world-postgres/dist");
  let source = await readFile(resolve(root, "streamer.js"), "utf8");
  source = source.replace("import { Client } from 'pg';", `export const testClients=[];
    class Client extends EventEmitter {constructor(){super();this.queries=[];this.ended=0;testClients.push(this)}
      async connect(){} async query(text){this.queries.push(text)} async end(){this.ended++}}`);
  source = source.replace(/from '([^']+)'/g, (match, specifier: string) => specifier.startsWith("node:") ? match
    : `from ${JSON.stringify(specifier.startsWith(".") ? pathToFileURL(resolve(root, specifier)).href : import.meta.resolve(specifier))}`);
  return await import("data:text/javascript;base64," + Buffer.from(source).toString("base64")) as {
    createStreamer: (pool: never, drizzle: never) => { close(): Promise<void> };
    testClients: (import("node:events").EventEmitter & { queries: string[]; ended: number })[];
  };
}

describe("Postgres stream LISTEN connection loss", () => {
  it("logs a lost notification connection without throwing and closes it without UNLISTEN", async () => {
    const { createStreamer, testClients: clients } = await loadInstalledStreamer();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const streamer = createStreamer({ options: {} } as never, {} as never);
      const client = clients.at(-1)!;
      await vi.waitFor(() => expect(client.queries).toContain("LISTEN workflow_event_chunk"));
      const failure = Object.assign(new Error("Connection terminated unexpectedly"), { code: "57P01" });

      // A pg Client emits 'error' when its socket dies; an EventEmitter without a listener throws.
      expect(() => client.emit("error", failure)).not.toThrow();
      expect(() => client.emit("error", failure)).not.toThrow();
      expect(log).toHaveBeenCalledOnce();
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
        code: "AGENT_WORKFLOW_NOTIFY_CONNECTION_LOST",
        databaseCode: "57P01",
      });

      await streamer.close();
      expect(client.queries).not.toContain("UNLISTEN workflow_event_chunk");
      expect(client.ended).toBe(1);
      // A late socket event after close must stay harmless too.
      expect(() => client.emit("error", failure)).not.toThrow();
    } finally {
      log.mockRestore();
    }
  });

  it("still unsubscribes a healthy notification connection on close", async () => {
    const { createStreamer, testClients: clients } = await loadInstalledStreamer();
    const streamer = createStreamer({ options: {} } as never, {} as never);
    const client = clients.at(-1)!;
    await vi.waitFor(() => expect(client.queries).toContain("LISTEN workflow_event_chunk"));
    await streamer.close();
    expect(client.queries).toContain("UNLISTEN workflow_event_chunk");
    expect(client.ended).toBe(1);
  });
});
