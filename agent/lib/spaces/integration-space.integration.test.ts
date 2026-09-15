/** An external call is reached only while the verified actor retains space integration rights. */
import { afterAll,describe,expect,it,vi } from "vitest";
import { database,closeDatabase } from "../database.js";
import { createTwoSpaceFixture,twoSpaceMemoryAuthorization } from "./two-space-fixture.js";
import { withIntegrationSpace } from "./integration-space.js";
const enabled=process.env.RUN_DATABASE_INTEGRATION_TESTS==="true";
if(enabled&&!new URL(process.env.DATABASE_URL!).pathname.endsWith("_test"))throw new Error("AGENT_TEST_DATABASE_UNSAFE");
(enabled?describe:describe.skip)("integration space boundary",()=>{
  afterAll(closeDatabase);
  it("checks the live role before making the external call",async()=>{
    await database().query("TRUNCATE families,users CASCADE");
    const f=await createTwoSpaceFixture("integration-call");
    const auth=()=>twoSpaceMemoryAuthorization({as:f.spouse,spaceId:f.pairSpaceId,chat:"private",fixture:f});
    const call=vi.fn(async()=>"result");
    await expect(withIntegrationSpace(await auth(),call)).resolves.toBe("result");
    await database().query("UPDATE space_memberships SET role='helper' WHERE space_id=$1 AND user_id=$2",[f.pairSpaceId,f.spouse.userId]);
    await expect(withIntegrationSpace(await auth(),call)).rejects.toMatchObject({code:"AGENT_SPACE_ACCESS_DENIED"});
    expect(call).toHaveBeenCalledTimes(1);
  });
});
