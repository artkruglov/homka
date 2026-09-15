import { describe, expect, it, vi } from "vitest";
import { createPagedStream } from "./paged-stream.ts";

function fixture() {
  let wake = () => {};
  const unsubscribe = vi.fn();
  const initialize = vi.fn(async (index: number) => ({ after: index === 0 ? null : `id-${index}`, skip: 0 }));
  const page = vi.fn(async (_after: string | null) => [
    { id: "id-2", data: new Uint8Array([2]), eof: false },
    { id: "id-3", data: new Uint8Array([3]), eof: false },
    { id: "id-4", data: new Uint8Array(), eof: true },
  ]);
  return { initialize, page, unsubscribe, notify: () => wake(), subscribe(fn: () => void) { wake = fn; return unsubscribe; } };
}

describe("bounded durable stream consumption", () => {
  it("does not fetch before demand, reads from the requested cursor and unsubscribes at EOF", async () => {
    const f = fixture(); const stream = createPagedStream(f, 1);
    await Promise.resolve(); expect(f.page).not.toHaveBeenCalled();
    const reader = stream.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([2]));
    expect(f.initialize).toHaveBeenCalledWith(1);
    expect(f.page).toHaveBeenCalledWith("id-1");
    expect((await reader.read()).value).toEqual(new Uint8Array([3]));
    expect((await reader.read()).done).toBe(true);
    expect(f.page).toHaveBeenCalledOnce(); expect(f.unsubscribe).toHaveBeenCalledOnce();
    reader.releaseLock();
  });

  it("waits for new durable data and recovers a missed notification by polling, not retrying errors", async () => {
    vi.useFakeTimers();
    const f = fixture(); f.page.mockResolvedValueOnce([]);
    const reader = createPagedStream(f, 0).getReader();
    try {
      const pending = reader.read();
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await pending).value).toEqual(new Uint8Array([2]));
      expect(f.page).toHaveBeenCalledTimes(2);
    } finally { await reader.cancel(); reader.releaseLock(); vi.useRealTimers(); }
  });

  it("does not miss a notification arriving while the empty page is being fetched", async () => {
    const f = fixture(); f.page.mockImplementationOnce(async () => { f.notify(); return []; });
    const reader = createPagedStream(f, 0).getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([2]));
    expect(f.page).toHaveBeenCalledTimes(2);
    await reader.cancel(); reader.releaseLock(); expect(f.unsubscribe).toHaveBeenCalledOnce();
  });

  it("cancels an in-flight page without late enqueue, new queries, or leaked subscriptions", async () => {
    const f = fixture(); let release!: (value: Awaited<ReturnType<typeof f.page>>) => void;
    f.page.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const reader = createPagedStream(f, 0).getReader(); const pending = reader.read();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await reader.cancel(); release([{ id: "late", data: new Uint8Array([1]), eof: false }]);
    expect((await pending).done).toBe(true);
    await Promise.resolve(); expect(f.page).toHaveBeenCalledOnce(); expect(f.unsubscribe).toHaveBeenCalledOnce();
    reader.releaseLock();
  });

  it("propagates a database failure once and removes its listener", async () => {
    const f = fixture(); const error = new Error("database unavailable"); f.page.mockRejectedValue(error);
    const reader = createPagedStream(f, 0).getReader();
    await expect(reader.read()).rejects.toBe(error);
    expect(f.page).toHaveBeenCalledOnce(); expect(f.unsubscribe).toHaveBeenCalledOnce(); reader.releaseLock();
  });

  // pg carves small Buffers out of one shared 8 KB pool, and a byte-stream reader (the native
  // abort path) may transfer an enqueued chunk's backing ArrayBuffer. Handing over the pooled view
  // detaches memory the driver still uses for other rows, so each chunk leaves owning its own copy.
  it("enqueues a copy instead of the driver's pooled buffer", async () => {
    const pool = new ArrayBuffer(64);
    new Uint8Array(pool).set([7, 9], 8);
    const f = fixture();
    f.page.mockResolvedValueOnce([
      { id: "id-2", data: new Uint8Array(pool, 8, 2), eof: false },
      { id: "id-3", data: new Uint8Array(), eof: true },
    ]);
    const reader = createPagedStream(f, 0).getReader();

    const { value } = await reader.read();
    expect(value).toEqual(new Uint8Array([7, 9]));
    expect(value!.buffer).not.toBe(pool);
    expect(value!.byteOffset).toBe(0);
    expect(value!.buffer.byteLength).toBe(2);
    await reader.cancel(); reader.releaseLock();
  });

  it("skips future data positions but still closes at EOF", async () => {
    const f = fixture(); f.initialize.mockResolvedValue({ after: "id-1", skip: 5 });
    const reader = createPagedStream(f, 6).getReader();
    expect((await reader.read()).done).toBe(true); expect(f.unsubscribe).toHaveBeenCalledOnce(); reader.releaseLock();
  });
});
