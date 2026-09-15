/** Preserve Eve's event format while propagating consumer demand and cancellation to the world. */
export function parseNdjsonStream<T = unknown>(open: () => ReadableStream<Uint8Array>): ReadableStream<T> {
  const decoder = new TextDecoder();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let buffer = "", ended = false, finished = false;
  async function cancel(reason?: unknown) {
    finished = true; buffer = "";
    const active = reader; reader = undefined;
    if (active) { try { await active.cancel(reason); } finally { active.releaseLock(); } }
  }
  return new ReadableStream<T>({
    async pull(controller) {
      try {
        reader ??= open().getReader();
        while (!finished) {
          const newline = buffer.indexOf("\n");
          if (newline >= 0 || ended) {
            const line = (newline >= 0 ? buffer.slice(0, newline) : buffer).trim();
            buffer = newline >= 0 ? buffer.slice(newline + 1) : "";
            if (line) { controller.enqueue(JSON.parse(line)); return; }
            if (ended && !buffer) {
              finished = true; reader.releaseLock(); reader = undefined; controller.close(); return;
            }
            continue;
          }
          const chunk = await reader.read();
          if (finished) return;
          if (chunk.done) { ended = true; buffer += decoder.decode(); }
          else buffer += decoder.decode(chunk.value, { stream: true });
        }
      } catch (error) {
        try { await cancel(error); }
        catch (cleanupError) { console.error("AGENT_WORKFLOW_STREAM_CLEANUP_FAILED", { cleanupError }); }
        controller.error(error);
      }
    }, cancel,
  }, { highWaterMark: 0 });
}
