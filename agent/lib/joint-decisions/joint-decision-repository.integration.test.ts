/** Two verified people consent independently; receipts, privacy and withdrawal are durable. */
import { afterAll,beforeEach,describe,expect,it } from "vitest";
import { database,closeDatabase } from "../database.js";
import { createTwoSpaceFixture,twoSpaceMemoryAuthorization,type TwoSpaceFixture } from "../spaces/two-space-fixture.js";
import { jointDecisionRepository as repo } from "./joint-decision-repository.js";
const enabled=process.env.RUN_DATABASE_INTEGRATION_TESTS==="true";
if(enabled&&!new URL(process.env.DATABASE_URL!).pathname.endsWith("_test"))throw new Error("AGENT_TEST_DATABASE_UNSAFE");
let f:TwoSpaceFixture;
const auth=(as=f.owner,spaceId=f.pairSpaceId)=>twoSpaceMemoryAuthorization({fixture:f,as,chat:"private",spaceId});
async function create(){
  const owner=await auth();
  const people=(await repo.execute(owner,{action:"participants"},"people")).participants!;
  return (await repo.execute(owner,{action:"create",title:"В воскресенье идём в парк",partnerRef:people.find(p=>p.name==="Супруга")!.participantRef},"create")).decision!;
}
(enabled?describe:describe.skip)("joint decision persistence",()=>{
  beforeEach(async()=>{await database().query("TRUNCATE families,users CASCADE");f=await createTwoSpaceFixture("joint-decision");});
  afterAll(closeDatabase);
  it("requires both answers, preserves replay, and records only the speaker's feedback",async()=>{
    const d=await create(),owner=await auth(),spouse=await auth(f.spouse);
    expect(d).toMatchObject({status:"open",answers:[]});
    const first={action:"answer" as const,id:d.id,version:d.version,choice:"agree" as const};
    const one=(await repo.execute(owner,first,"one")).decision!;
    expect(one.status).toBe("open");
    expect((await repo.execute(owner,first,"one")).replayed).toBe(true);
    const both=(await repo.execute(spouse,{...first,version:one.version},"two")).decision!;
    expect(both.status).toBe("agreed");expect(both.answers).toHaveLength(2);
    const feedback=(await repo.execute(spouse,{action:"feedback",id:d.id,version:both.version,text:"Мне понравилась прогулка"},"feedback")).decision!;
    expect(feedback.feedback).toEqual([expect.objectContaining({name:"Супруга",text:"Мне понравилась прогулка",isYou:true})]);
    await expect(repo.execute(owner,{action:"withdraw_feedback",id:d.id,version:feedback.version},"not-yours")).rejects.toThrow(/AGENT_DECISION_FEEDBACK_ABSENT/);
    const cleared=(await repo.execute(spouse,{action:"withdraw_feedback",id:d.id,version:feedback.version},"withdraw")).decision!;
    expect(cleared.feedback).toEqual([]);
    expect((await database().query("SELECT count(*)::int AS n FROM joint_decisions")).rows[0].n).toBe(1);
  });
  it("rejects neighboring space, stale changes and revoked access",async()=>{
    const d=await create(),owner=await auth(),spouse=await auth(f.spouse);
    await expect(repo.execute(await auth(f.owner,f.householdSpaceId),{action:"get",id:d.id},"wrong-space")).rejects.toThrow(/AGENT_DECISION_ACCESS_DENIED/);
    await repo.execute(owner,{action:"answer",id:d.id,version:1,choice:"agree"},"one");
    await expect(repo.execute(spouse,{action:"answer",id:d.id,version:1,choice:"agree"},"stale")).rejects.toThrow(/AGENT_DECISION_VERSION_CONFLICT/);
    await database().query("DELETE FROM family_memberships WHERE family_id=$1 AND user_id=$2",[f.familyId,f.spouse.userId]);
    await expect(repo.execute(spouse,{action:"get",id:d.id},"revoked")).rejects.toThrow();
  });
  it("only lets the proposer cancel and never reopens cancellation on a late answer",async()=>{
    const d=await create(),owner=await auth(),spouse=await auth(f.spouse);
    await expect(repo.execute(spouse,{action:"cancel",id:d.id,version:1},"wrong-cancel")).rejects.toThrow(/AGENT_DECISION_ACCESS_DENIED/);
    const cancelled=(await repo.execute(owner,{action:"cancel",id:d.id,version:1},"cancel")).decision!;
    expect(cancelled.status).toBe("cancelled");
    await expect(repo.execute(spouse,{action:"answer",id:d.id,version:cancelled.version,choice:"agree"},"late")).rejects.toThrow(/AGENT_DECISION_CANCELLED/);
  });
  it("keeps proposal wording and answer authors protected in the database",async()=>{
    const d=await create();
    await expect(database().query("UPDATE joint_decisions SET title='Другое предложение' WHERE id=$1",[d.id])).rejects.toThrow(/AGENT_DECISION_PROPOSAL_IMMUTABLE/);
    const other=(await database().query("INSERT INTO users(telegram_user_id,display_name) VALUES('decision-outsider','Другой') RETURNING id")).rows[0].id;
    await expect(database().query("INSERT INTO joint_decision_answers(decision_id,actor_user_id,choice) VALUES($1,$2,'agree')",[d.id,other])).rejects.toThrow(/AGENT_DECISION_PARTICIPANT_INVALID/);
    expect((await repo.execute(await auth(),{action:"get",id:d.id},"get")).decision).toMatchObject({title:"В воскресенье идём в парк",answers:[],status:"open"});
  });
});
