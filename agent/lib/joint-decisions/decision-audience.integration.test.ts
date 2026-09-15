/** Joint proposals may select only live members of the proven shared audience. */
import { afterAll,beforeEach,describe,expect,it } from "vitest";
import { database,closeDatabase } from "../database.js";
import { createTwoSpaceFixture,twoSpaceMemoryAuthorization,type TwoSpaceFixture } from "../spaces/two-space-fixture.js";
import { decisionAudience } from "./decision-audience.js";
const enabled=process.env.RUN_DATABASE_INTEGRATION_TESTS==="true";
if(enabled&&!new URL(process.env.DATABASE_URL!).pathname.endsWith("_test"))throw new Error("AGENT_TEST_DATABASE_UNSAFE");
let f:TwoSpaceFixture;
async function audience(spaceId:string,as=f.owner){
  const auth=await twoSpaceMemoryAuthorization({fixture:f,as,chat:"private",spaceId});
  const client=await database().connect();
  try{await client.query("BEGIN");const result=await decisionAudience(client,auth);await client.query("COMMIT");return result;}
  catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
}
(enabled?describe:describe.skip)("decision audience",()=>{
  beforeEach(async()=>{await database().query("TRUNCATE families,users CASCADE");f=await createTwoSpaceFixture("decision-audience");});
  afterAll(closeDatabase);
  it("returns opaque references only for the selected shared space",async()=>{
    const pair=await audience(f.pairSpaceId),house=await audience(f.householdSpaceId);
    expect(pair.participants.map(p=>p.name).sort()).toEqual(["Владелец","Супруга"]);
    expect(house.participants.map(p=>p.name)).toEqual(["Владелец"]);
    expect(Object.keys(pair.participants[0]!).sort()).toEqual(["name","participantRef"]);
    await expect(audience(f.householdSpaceId,f.spouse)).rejects.toThrow(/AGENT_SPACE_ACCESS_DENIED/);
  });
  it("does not treat an unproven private chat as permission to publish to the family",async()=>{
    const auth=await twoSpaceMemoryAuthorization({fixture:f,as:f.owner,chat:"private",spaceId:f.pairSpaceId});
    const {space:_,...unproven}=auth;
    const client=await database().connect();
    try{await expect(decisionAudience(client,unproven)).rejects.toThrow(/AGENT_DECISION_SHARED_SPACE_REQUIRED/);}
    finally{client.release();}
  });
  it("rechecks family membership rather than trusting a session role",async()=>{
    await database().query("DELETE FROM family_memberships WHERE family_id=$1 AND user_id=$2",[f.familyId,f.owner.userId]);
    await expect(audience(f.pairSpaceId)).rejects.toThrow();
  });
});
