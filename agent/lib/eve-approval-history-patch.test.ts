import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

// Exercise the actual installed parking expression, including the mutation of the
// transcript that Eve stores in the next pending batch. No provider or side effect runs.
async function park(response: unknown[], pending = true) {
  const source = await readFile("node_modules/eve/dist/src/harness/tool-loop.js", "utf8");
  const start = source.indexOf("w=", source.indexOf("S=[...b,...ne]"));
  const end = source.indexOf(",re=getAdvertisedTools", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const call = { role: "assistant", content: [{ type: "tool-call", toolCallId: "first" }] };
  return runInNewContext(`let ${source.slice(start, end)}; ({history:w, deferred:g})`, {
    r: [call], g: structuredClone(response), S: pending ? [{}] : [],
    C: pending ? "[Pending approvals] second" : undefined,
  });
}

const result = { role: "tool", content: [{ type: "tool-result", toolCallId: "first", output: { type: "json", value: { active: true } } }] };
const nextCall = { role: "assistant", content: [{ type: "tool-call", toolCallId: "second" }] };

describe("Eve consecutive approval history", () => {
  it("persists the completed first result before parking the second approval", async () => {
    const { history, deferred } = await park([result, nextCall]);
    expect(history[1]).toEqual(result);
    expect(history[2].content).toBe("[Pending approvals] second");
    expect(deferred).toEqual([nextCall]);
    // Resuming the pending batch does not duplicate the first result.
    expect([...history, ...deferred].filter(m => m.role === "tool")).toEqual([result]);
  });

  it("retains all leading tool messages, including denied results", async () => {
    const denied = { role: "tool", content: [{ type: "tool-result", toolCallId: "other", output: { type: "execution-denied" } }] };
    const { history, deferred } = await park([result, denied, nextCall]);
    expect(history.slice(1, 3)).toEqual([result, denied]);
    expect(deferred).toEqual([nextCall]);
  });

  it("keeps a new approval's entire response deferred", async () => {
    const { history, deferred } = await park([nextCall, result]);
    expect(history).toHaveLength(2);
    expect(deferred).toEqual([nextCall, result]);
  });

  it("leaves ordinary completed responses intact", async () => {
    const { deferred } = await park([result, nextCall], false);
    expect(deferred).toEqual([result, nextCall]);
  });
});
