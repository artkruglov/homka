/** Real installed world + SQL, only in the project's isolated Compose test database. */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createStreamer } from "../../node_modules/@workflow/world-postgres/dist/streamer.js";
import { createClient } from "../../node_modules/@workflow/world-postgres/dist/drizzle/index.js";

// The disposable workflow database is a second connection; a local run without it skips the test.
describe.skipIf(process.env.RUN_DATABASE_INTEGRATION_TESTS !== "true" || !process.env.WORKFLOW_POSTGRES_URL)("patched Postgres stream", () => {
  it("reads positive/negative cursors, pages historical data and follows newly committed rows", async () => {
    if (!process.env.WORKFLOW_POSTGRES_URL) throw new Error("TEST_WORKFLOW_DATABASE_MISSING");
    const pool = new Pool({ connectionString: process.env.WORKFLOW_POSTGRES_URL, max: 2 });
    const query = vi.spyOn(pool, "query");
    const streamer = createStreamer(pool, createClient(pool));
    const runId = `stream-test-${randomUUID()}`, name = `strm_${runId}`;
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    try {
      await streamer.streams.writeMulti!(runId, name, Array.from({ length: 70 }, (_, i) => Buffer.from(String(i))));
      const tail = (await streamer.streams.get(runId, name, 69)).getReader(); readers.push(tail);
      expect(Buffer.from((await tail.read()).value!).toString()).toBe("69");
      const pending = tail.read();
      await streamer.streams.write(runId, name, Buffer.from("70"));
      expect(Buffer.from((await pending).value!).toString()).toBe("70");
      await streamer.streams.close(runId, name);
      expect((await tail.read()).done).toBe(true);

      const negative = (await streamer.streams.get(runId, name, -2)).getReader(); readers.push(negative);
      expect(Buffer.from((await negative.read()).value!).toString()).toBe("69");
      expect(Buffer.from((await negative.read()).value!).toString()).toBe("70");
      expect((await negative.read()).done).toBe(true);
      const beyond = (await streamer.streams.get(runId, name, 100)).getReader(); readers.push(beyond);
      expect((await beyond.read()).done).toBe(true);

      const full = (await streamer.streams.get(runId, name)).getReader(); readers.push(full);
      const values = [];
      while (true) { const next = await full.read(); if (next.done) break; values.push(Buffer.from(next.value).toString()); }
      expect(values).toEqual(Array.from({ length: 71 }, (_, i) => String(i)));
      const sql = query.mock.calls.map(([config]) => typeof config === "string" ? config : (config as { text?: string }).text);
      const payloadReads = sql.filter((text): text is string => !!text?.startsWith("select") && text.includes('"data"'));
      expect(payloadReads.length).toBeGreaterThan(0);
      expect(payloadReads.every(text => /\blimit\b/i.test(text))).toBe(true);
    } finally {
      for (const reader of readers) { await reader.cancel(); reader.releaseLock(); }
      await streamer.close();
      await pool.query("DELETE FROM workflow.workflow_stream_chunks WHERE run_id=$1", [runId]);
      await pool.end();
    }
  }, 15_000);
});
