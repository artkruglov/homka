import { describe, expect, it, vi } from "vitest";
import { parseNdjsonStream } from "./ndjson-stream.ts";

describe("demand-driven Eve event decoding", () => {
  it("does not open or drain the source ahead of its consumer", async () => {
    const pull = vi.fn((c: ReadableStreamDefaultController<Uint8Array>) => c.enqueue(new TextEncoder().encode('{"n":1}\n')));
    const cancel = vi.fn(); const open = vi.fn(() => new ReadableStream({ pull, cancel }, { highWaterMark: 0 }));
    const reader = parseNdjsonStream(open).getReader();
    await Promise.resolve(); expect(open).not.toHaveBeenCalled();
    expect((await reader.read()).value).toEqual({ n: 1 });
    await Promise.resolve(); expect(pull).toHaveBeenCalledOnce();
    await reader.cancel(); reader.releaseLock(); expect(cancel).toHaveBeenCalledOnce();
  });
  it("preserves UTF-8 across chunks and a final record without newline", async () => {
    const bytes = new TextEncoder().encode('{"n":"тест"}\n\n{"n":2}'); let index = 0;
    const reader = parseNdjsonStream(() => new ReadableStream({
      pull(c) { if (index === bytes.length) c.close(); else c.enqueue(bytes.slice(index, ++index)); },
    }, { highWaterMark: 0 })).getReader();
    expect((await reader.read()).value).toEqual({ n: "тест" });
    expect((await reader.read()).value).toEqual({ n: 2 });
    expect((await reader.read()).done).toBe(true); reader.releaseLock();
  });
  it("cancels the underlying stream on invalid JSON and preserves the parse error", async () => {
    const cancel = vi.fn();
    const reader = parseNdjsonStream(() => new ReadableStream({
      pull(c) { c.enqueue(new TextEncoder().encode('invalid\n')); }, cancel,
    }, { highWaterMark: 0 })).getReader();
    await expect(reader.read()).rejects.toBeInstanceOf(SyntaxError);
    expect(cancel).toHaveBeenCalledOnce(); reader.releaseLock();
  });
});
