/** A retained family-owner role cannot bypass a revoked space administration grant. */
import { afterAll,beforeEach,describe,expect,it } from "vitest";
import { database,closeDatabase } from "../database.js";
import { familyRepository } from "../family-repository.js";
import { telegramGroupAdministrationRepository as groups } from "../telegram-group-administration-repository.js";
import { createTwoSpaceFixture,currentSpacePolicyVersion,type TwoSpaceFixture } from "./two-space-fixture.js";
const enabled=process.env.RUN_DATABASE_INTEGRATION_TESTS==="true";
if(enabled&&!new URL(process.env.DATABASE_URL!).pathname.endsWith("_test"))throw new Error("AGENT_TEST_DATABASE_UNSAFE");
let f:TwoSpaceFixture;
(enabled?describe:describe.skip)("administration space role",()=>{
  beforeEach(async()=>{await database().query("TRUNCATE families,users CASCADE");f=await createTwoSpaceFixture("admin-role",{ownerManagesSpaces:true});});
  afterAll(closeDatabase);
  it("rechecks manage_members when approving a previously claimed invitation",async()=>{
    const invitation=await familyRepository.createInvitation(f.familyId,f.owner.userId,"role-invite");
    await familyRepository.claimInvitation(invitation.code,{telegramUserId:"candidate-role",displayName:"Кандидат"});
    const space={spaceId:f.pairSpaceId,policyVersion:await currentSpacePolicyVersion(f.pairSpaceId)};
    await database().query("UPDATE space_memberships SET role='helper' WHERE space_id=$1 AND user_id=$2",[f.pairSpaceId,f.owner.userId]);
    await expect(familyRepository.approveInvitation({familyId:f.familyId,approvedBy:f.owner.userId,
      invitationId:invitation.invitationId,candidateDisplayName:"Кандидат",candidateTelegramUserId:"candidate-role",operationKey:"role-approve",space} as never))
      .rejects.toMatchObject({code:"AGENT_SPACE_ACCESS_DENIED"});
    expect((await database().query("SELECT count(*)::int AS n FROM family_memberships WHERE family_id=$1",[f.familyId])).rows[0].n).toBe(2);
  });
  it("rejects registration after downgrade and rejects omitted proof in spaces mode",async()=>{
    const space={spaceId:f.pairSpaceId,policyVersion:await currentSpacePolicyVersion(f.pairSpaceId)};
    const input={familyId:f.familyId,requestedBy:f.owner.userId,telegramChatId:"-8080808",title:"Новый чат",
      type:"external" as const,messageMode:"all" as const,toolAllowlist:[],space};
    await database().query("UPDATE space_memberships SET role='helper' WHERE space_id=$1 AND user_id=$2",[f.pairSpaceId,f.owner.userId]);
    await expect(groups.registerGroup(input)).rejects.toMatchObject({code:"AGENT_SPACE_ACCESS_DENIED"});
    await database().query("UPDATE family_space_runtime SET mode='spaces',cutover_at=now(),reason='test' WHERE family_id=$1",[f.familyId]);
    const {space:_,...unproven}=input;
    await expect(groups.registerGroup(unproven)).rejects.toMatchObject({code:"AGENT_SPACE_CONTEXT_REQUIRED"});
    expect((await database().query("SELECT 1 FROM telegram_groups WHERE telegram_chat_id='-8080808'")).rowCount).toBe(0);
  });
});
