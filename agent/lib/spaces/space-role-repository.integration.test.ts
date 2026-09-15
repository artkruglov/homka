/** Owner-assigned roles narrow the real space immediately, with no new reader or identity guess. */
import { afterAll,beforeEach,describe,expect,it } from "vitest";
import { database,closeDatabase } from "../database.js";
import { createTwoSpaceFixture,twoSpaceMemoryAuthorization,type TwoSpaceFixture } from "./two-space-fixture.js";
import { spaceRoleRepository } from "./space-role-repository.js";
const enabled=process.env.RUN_DATABASE_INTEGRATION_TESTS==="true";
if(enabled&&!new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("AGENT_TEST_DATABASE_UNSAFE");
let f:TwoSpaceFixture;
const auth=(spouse=false)=>twoSpaceMemoryAuthorization({as:spouse?f.spouse:f.owner,spaceId:f.pairSpaceId,chat:"private",fixture:f});
(enabled?describe:describe.skip)("space role administration",()=>{
  beforeEach(async()=>{await database().query("TRUNCATE families,users CASCADE");f=await createTwoSpaceFixture("role-admin",{ownerManagesSpaces:true});});
  afterAll(closeDatabase);
  it("narrows an existing member to helper then child, and refuses expansion",async()=>{
    const owner=await auth();
    const initial=await spaceRoleRepository.members(owner,f.pairSpaceId);
    const target=initial.members.find(m=>m.role==="adult")!;
    expect(target.memberRef).not.toBe(f.spouse.userId);
    await spaceRoleRepository.assign(owner,{areaRef:f.pairSpaceId,memberRef:target.memberRef,role:"helper",policyVersion:initial.policyVersion});
    const helper=await spaceRoleRepository.members(owner,f.pairSpaceId);
    expect(helper.members.find(m=>m.memberRef===target.memberRef)?.role).toBe("helper");
    await spaceRoleRepository.assign(owner,{areaRef:f.pairSpaceId,memberRef:target.memberRef,role:"child",policyVersion:helper.policyVersion});
    const child=await spaceRoleRepository.members(owner,f.pairSpaceId);
    await expect(spaceRoleRepository.assign(owner,{areaRef:f.pairSpaceId,memberRef:target.memberRef,role:"helper",policyVersion:child.policyVersion}))
      .rejects.toMatchObject({code:"AGENT_SPACE_ROLE_NEW_SPACE_REQUIRED"});
  });
  it("rechecks the family owner after approval and never accepts a member from another space",async()=>{
    const owner=await auth();
    const initial=await spaceRoleRepository.members(owner,f.pairSpaceId);
    const target=initial.members.find(m=>m.role==="adult")!;
    await expect(spaceRoleRepository.assign(owner,{areaRef:f.householdSpaceId,memberRef:target.memberRef,role:"helper",policyVersion:1})).rejects.toThrow();
    await database().query("UPDATE family_memberships SET role='member' WHERE user_id=$1 AND family_id=$2",[f.owner.userId,f.familyId]);
    await expect(spaceRoleRepository.assign(owner,{areaRef:f.pairSpaceId,memberRef:target.memberRef,role:"helper",policyVersion:initial.policyVersion}))
      .rejects.toMatchObject({code:"AGENT_OWNER_REQUIRED"});
    await expect(spaceRoleRepository.members(await auth(true),f.pairSpaceId)).rejects.toMatchObject({code:"AGENT_OWNER_REQUIRED"});
  });
});
