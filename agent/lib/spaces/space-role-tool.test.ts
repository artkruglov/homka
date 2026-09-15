/** Role changes require approval of the exact call before repository execution. */
import { describe,expect,it,vi } from "vitest";
const mocks=vi.hoisted(()=>({approve:vi.fn(async()=>{throw new Error("approval missing");}),assign:vi.fn()}));
vi.mock("../require-tool-approval-evidence.js",()=>({requireToolApprovalEvidence:mocks.approve}));
vi.mock("../memory-context.js",()=>({requireMemoryAuthorization:()=>({userId:"owner",role:"owner",groupId:null})}));
vi.mock("./space-role-repository.js",()=>({spaceRoleRepository:{assign:mocks.assign}}));
vi.mock("../tool-policy/mode-tool-surface.js",()=>({buildModeToolSurface:()=>({})}));
import tool from "../tools/manage_space.js";
describe("role assignment tool",()=>{
  const input={action:"set_role" as const,areaRef:"00000000-0000-4000-8000-000000000001",memberRef:"00000000-0000-4000-8000-000000000002",role:"child" as const,policyVersion:1};
  it("requests approval for role assignment",()=>{
    expect(typeof tool.approval).toBe("function");
    expect((tool.approval as Function)({toolInput:input})).toBe("user-approval");
  });
  it("does not mutate before durable approval evidence",async()=>{
    await expect(tool.execute!(input as never,{session:{auth:{current:{attributes:{}}}}} as never)).rejects.toThrow("approval missing");
    expect(mocks.assign).not.toHaveBeenCalled();
  });
});
