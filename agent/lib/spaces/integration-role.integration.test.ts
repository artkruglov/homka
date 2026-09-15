/** Role revocation must stop a credentialed operation at the existing execution boundary. */
import { afterAll,beforeEach,describe,expect,it,vi } from "vitest";
import { database,closeDatabase } from "../database.js";
import { createTwoSpaceFixture,type TwoSpaceFixture } from "./two-space-fixture.js";
import { withGoogleWorkspaceExecutionAccount } from "../google-workspace/google-execution-authorization.js";
const enabled=process.env.RUN_DATABASE_INTEGRATION_TESTS==="true";
if(enabled&&!new URL(process.env.DATABASE_URL!).pathname.endsWith("_test"))throw new Error("AGENT_TEST_DATABASE_UNSAFE");
let f:TwoSpaceFixture;
(enabled?describe:describe.skip)("integration role",()=>{
  beforeEach(async()=>{await database().query("TRUNCATE families,users CASCADE");f=await createTwoSpaceFixture("integration-role");});
  afterAll(closeDatabase);
  it.each(["helper","child"])("stops Google execution after downgrade to %s",async role=>{
    const workspace=(await database().query("INSERT INTO workspaces(family_id,scope,space_id) VALUES($1,'family',$2) RETURNING id",[f.familyId,f.pairSpaceId])).rows[0].id;
    const auth={familyId:f.familyId,scope:"family" as const,role:"member" as const,userId:f.spouse.userId,
      telegramUserId:f.spouse.telegramUserId,workspaceId:workspace};
    const execute=vi.fn(async()=>"read");
    await expect(withGoogleWorkspaceExecutionAccount(auth,"test",execute)).resolves.toBe("read");
    await database().query("UPDATE space_memberships SET role=$3 WHERE space_id=$1 AND user_id=$2",[f.pairSpaceId,f.spouse.userId,role]);
    await expect(withGoogleWorkspaceExecutionAccount(auth,"test",execute)).rejects.toMatchObject({code:"AGENT_SPACE_ACCESS_DENIED"});
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
