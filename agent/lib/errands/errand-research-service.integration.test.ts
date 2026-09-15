import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, database } from "../database.js";
import { createTwoSpaceFixture, twoSpaceMemoryAuthorization, type TwoSpaceFixture } from "../spaces/two-space-fixture.js";
import { listErrandRecipients } from "./errand-recipients.js";
import { errandRepository } from "./errand-repository.js";
import { createErrandResearchService } from "./errand-research-service.js";
import { errandToolInput } from "./errand-contract.js";

const enabled=process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if(enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test"))throw new Error("AGENT_TEST_DATABASE_UNSAFE");
let fixture:TwoSpaceFixture;
const auth=(as=fixture.owner)=>twoSpaceMemoryAuthorization({as,spaceId:fixture.pairSpaceId,chat:"private",fixture});
const invocation=()=>({operationKey:randomUUID(),sessionId:"initiator-session",turnId:"turn-1",privateQuery:"Личная причина: устал"});
const result={text:"Парк у реки",sources:[{url:"https://example.org/park",checkedAt:"2026-09-13T12:00:00Z"}]};
async function create(){
  const actor=await auth();
  const [recipient]=await listErrandRecipients(actor);
  const created=await errandRepository.execute(actor,{action:"create",brief:"Публичные парки",mode:"send",recipientRef:recipient!.recipientRef},invocation());
  return {id:created.errand!.id,version:created.errand!.version};
}

(enabled?describe:describe.skip)("durable backend research",()=>{
  beforeEach(async()=>{await database().query("TRUNCATE families,users CASCADE");fixture=await createTwoSpaceFixture("research-run");});
  afterAll(closeDatabase);

  it("rejects root-authored output and extra research context",()=>{
    const id=randomUUID();
    expect(errandToolInput.safeParse({action:"result",id,version:1,...result}).success).toBe(false);
    expect(errandToolInput.safeParse({action:"research",id,version:1,text:"Личная причина"}).success).toBe(false);
    expect(errandToolInput.safeParse({action:"research",id,version:1}).success).toBe(true);
  });
  it("passes only the saved brief, claims before I/O and reuses a completed result",async()=>{
    const input=await create();
    const ask=vi.fn(async(brief:string)=>{
      expect(brief).toBe("Публичные парки");
      expect((await database().query("SELECT state FROM errand_research_runs")).rows).toEqual([{state:"started"}]);
      return result;
    });
    const run=createErrandResearchService(ask);
    expect((await run(await auth(),input,invocation())).errand).toMatchObject({state:"queued",result});
    expect((await run(await auth(),input,invocation())).replayed).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
  });
  it("does not pay again after an ambiguous provider failure",async()=>{
    const input=await create();
    const ask=vi.fn(async()=>{throw new Error("timeout");});
    const run=createErrandResearchService(ask);
    await expect(run(await auth(),input,invocation())).rejects.toThrow("AGENT_ERRAND_RESEARCH_UNCERTAIN");
    await expect(run(await auth(),input,invocation())).rejects.toThrow("AGENT_ERRAND_RESEARCH_UNCERTAIN");
    expect(ask).toHaveBeenCalledTimes(1);
    expect((await database().query("SELECT state FROM errands")).rows).toEqual([{state:"preparing"}]);
  });
  it("treats a crash after the durable start marker as non-repeatable",async()=>{
    const input=await create();
    await database().query(`INSERT INTO errand_research_runs(errand_id,input_version,state,eve_session_id,eve_turn_id)
      VALUES($1,1,'started','crashed','turn')`,[input.id]);
    const ask=vi.fn();
    await expect(createErrandResearchService(ask)(await auth(),input,invocation())).rejects.toThrow("AGENT_ERRAND_RESEARCH_UNCERTAIN");
    expect(ask).not.toHaveBeenCalled();
  });
  it("cancellation wins over a late research result",async()=>{
    const input=await create();
    const actor=await auth();
    const run=createErrandResearchService(async()=>{
      await errandRepository.execute(actor,{action:"cancel",id:input.id},invocation());
      return result;
    });
    await expect(run(actor,input,invocation())).rejects.toThrow(/AGENT_ERRAND_VERSION_CONFLICT/);
    expect((await database().query("SELECT state FROM errands")).rows).toEqual([{state:"cancelled"}]);
    expect((await database().query("SELECT * FROM errand_results")).rowCount).toBe(0);
  });
  it("rechecks membership before queuing and retains the paid result for safe recovery",async()=>{
    const input=await create();
    const actor=await auth();
    const run=createErrandResearchService(async()=>{
      await database().query("DELETE FROM family_memberships WHERE family_id=$1 AND user_id=$2",[actor.familyId,actor.userId]);
      return result;
    });
    await expect(run(actor,input,invocation())).rejects.toThrow();
    expect((await database().query("SELECT state FROM errand_research_runs")).rows).toEqual([{state:"completed"}]);
    expect((await database().query("SELECT * FROM errand_results")).rowCount).toBe(0);
    await database().query("INSERT INTO family_memberships(family_id,user_id,role) VALUES($1,$2,'owner')",[actor.familyId,actor.userId]);
    const noNetwork=vi.fn(async()=>{throw new Error("must reuse persisted result");});
    expect((await createErrandResearchService(noNetwork)(actor,input,invocation())).errand).toMatchObject({state:"queued",result});
    expect(noNetwork).not.toHaveBeenCalled();
  });
  it("does not let another family member research a private draft",async()=>{
    const input=await create();
    const ask=vi.fn();
    await expect(createErrandResearchService(ask)(await auth(fixture.spouse),input,invocation())).rejects.toThrow();
    expect(ask).not.toHaveBeenCalled();
  });
  it("does not start a second paid request while the first one is running",async()=>{
    const input=await create();
    const actor=await auth();
    let release!:()=>void;
    let started!:()=>void;
    const ready=new Promise<void>(resolve=>{started=resolve;});
    const hold=new Promise<void>(resolve=>{release=resolve;});
    const ask=vi.fn(async()=>{started();await hold;return result;});
    const run=createErrandResearchService(ask);
    const first=run(actor,input,invocation());
    await ready;
    try {
      await expect(run(actor,input,invocation())).rejects.toThrow("AGENT_ERRAND_RESEARCH_UNCERTAIN");
      expect(ask).toHaveBeenCalledTimes(1);
    } finally {release();await first;}
  });
});
