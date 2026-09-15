/**
 * Progress notice deferral tests.
 *
 * Constructs covered:
 * - A step calling only quiet bookkeeping tools keeps the notice held; the next visible text
 *   discards it, so `remember` beside an answer no longer doubles the message.
 * - A step calling a slow tool releases the notice immediately.
 * - A turn ending with text still held flushes it as the answer.
 * - Release ignores a step index other than the held one; failures discard.
 * - A released notice is remembered for the turn so tool results can tell the model about it.
 */
import { describe, expect, it, vi } from "vitest";

import { createProgressNoticeDeferral, progressNoticeKey } from "./telegram-progress-deferral.js";

const key = progressNoticeKey("wrun_1", "turn_5");

describe("progress notice deferral", () => {
  it("keeps text held through a remember call and drops it when the answer follows", async () => {
    const deferral = createProgressNoticeDeferral();
    const send = vi.fn().mockResolvedValue(undefined);

    deferral.hold(key, { send, stepIndex: 1 });
    await deferral.release(key, 1, ["remember"]);
    expect(send).not.toHaveBeenCalled();
    expect(deferral.heldCount()).toBe(1);

    deferral.discard(key);
    await deferral.flush(key);
    expect(send).not.toHaveBeenCalled();
    expect(deferral.heldCount()).toBe(0);
  });

  it("releases at once for a slow tool", async () => {
    const deferral = createProgressNoticeDeferral();
    const send = vi.fn().mockResolvedValue(undefined);

    deferral.hold(key, { send, stepIndex: 0 });
    await deferral.release(key, 0, ["remember", "web_search"]);

    expect(send).toHaveBeenCalledOnce();
    expect(deferral.heldCount()).toBe(0);
  });

  it("flushes held text as the answer when the turn ends without new text", async () => {
    const deferral = createProgressNoticeDeferral();
    const send = vi.fn().mockResolvedValue(undefined);

    deferral.hold(key, { send, stepIndex: 1 });
    await deferral.release(key, 1, ["search_memories"]);
    await deferral.flush(key);

    expect(send).toHaveBeenCalledOnce();
    expect(deferral.heldCount()).toBe(0);
  });

  it("lets newer pre-tool text supersede the held one and ignores other steps", async () => {
    const deferral = createProgressNoticeDeferral();
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);

    deferral.hold(key, { send: first, stepIndex: 0 });
    await deferral.release(key, 0, ["remember"]);
    deferral.hold(key, { send: second, stepIndex: 1 });
    await deferral.release(key, 0, ["bash"]);
    expect(second).not.toHaveBeenCalled();
    await deferral.release(key, 1, ["bash"]);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it("remembers a sent notice until the turn is forgotten", async () => {
    const deferral = createProgressNoticeDeferral();

    deferral.hold(key, { send: vi.fn().mockResolvedValue(undefined), stepIndex: 0 });
    expect(deferral.wasSent(key)).toBe(false);
    await deferral.release(key, 0, ["remember"]);
    expect(deferral.wasSent(key)).toBe(false);
    await deferral.release(key, 0, ["generate_image"]);
    expect(deferral.wasSent(key)).toBe(true);

    deferral.forget(key);
    expect(deferral.wasSent(key)).toBe(false);
    expect(deferral.heldCount()).toBe(0);
  });

  it("releases when the step has no named tools at all", async () => {
    const deferral = createProgressNoticeDeferral();
    const send = vi.fn().mockResolvedValue(undefined);

    deferral.hold(key, { send, stepIndex: 0 });
    await deferral.release(key, 0, []);

    expect(send).toHaveBeenCalledOnce();
  });
});
