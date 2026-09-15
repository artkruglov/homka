/** A background or delegated turn cannot express consent on a human's behalf. */
import { beforeEach,describe,expect,it,vi } from "vitest";
const mocks=vi.hoisted(()=>({execute:vi.fn(async()=>({decision:{status:"open"}})),auth:vi.fn(()=>({userId:"person",role:"member",scopes:["family"]}))}));
vi.mock("./joint-decision-repository.js",()=>({jointDecisionRepository:{execute:mocks.execute}}));
vi.mock("../memory-context.js",()=>({requireMemoryAuthorization:mocks.auth}));
import tool from "../tools/manage_joint_decision.js";
const input={action:"list" as const};
const context=(attributes:Record<string,string|undefined>={},parent?:object)=>({callId:"call-1",session:{id:"session-1",parent,auth:{current:{attributes:{telegramChatType:"private",...attributes}}}}}) as never;
describe("joint decision tool",()=>{
  beforeEach(()=>vi.clearAllMocks());
  it("passes only verified authorization and a durable operation key to the repository",async()=>{
    await tool.execute!(input,context());
    expect(mocks.execute).toHaveBeenCalledWith({userId:"person",role:"member",scopes:["family"]},input,"session-1:call-1");
  });
  it.each([{scheduledRunId:"run"},{memoryReviewBatchId:"review"},{telegramChatType:"channel"}])("rejects noninteractive context %s",async(attributes)=>{
    await expect(tool.execute!(input,context(attributes))).rejects.toThrow(/AGENT_DECISION_INTERACTIVE_ONLY/);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("rejects a delegated call even with inherited private attributes",async()=>{
    await expect(tool.execute!(input,context({},{}))).rejects.toThrow(/AGENT_DECISION_INTERACTIVE_ONLY/);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
