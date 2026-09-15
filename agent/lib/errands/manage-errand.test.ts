/** A descriptor filter is not authorization: direct calls must reject background/group callers. */
import { describe, expect, it, vi } from "vitest";
vi.mock("../memory-context.js", () => ({ requireMemoryAuthorization: vi.fn(() => ({groupId:null})) }));
vi.mock("./errand-repository.js", () => ({ errandRepository: { execute: vi.fn(async () => ({errands:[]})) } }));
import tool from "../tools/manage_errand.js";
import { errandRepository } from "./errand-repository.js";

const context = (kind="telegram", attributes: Record<string,unknown>={telegramChatType:"private"}) => ({
  callId:"call",session:{id:"session",...(kind==="subagent"?{parent:{id:"parent"}}:{}),turn:{id:"turn"},auth:{current:{attributes}}},
});
describe("private interactive errand tool", () => {
  it.each([
    context("subagent"), context("telegram",{telegramChatType:"group"}),
    context("telegram",{telegramChatType:"private",scheduledRunId:"run"}),
    context("telegram",{telegramChatType:"private",memoryReviewBatchId:"batch"}),
  ])("rejects callers outside an interactive private session", async ctx => {
    await expect(tool.execute!({action:"list"},ctx as never)).rejects.toMatchObject({code:"AGENT_ERRAND_PRIVATE_ONLY"});
  });
  it("passes only verified call provenance to the repository", async () => {
    await tool.execute!({action:"list"},context() as never);
    expect(errandRepository.execute).toHaveBeenLastCalledWith({groupId:null},{action:"list"},
      {operationKey:"session:call",sessionId:"session",turnId:"turn",privateQuery:""});
  });
});
