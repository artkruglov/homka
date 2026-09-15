/** A request followup belongs to its author and ends when the recipient answers. */
import { afterAll,beforeEach,describe,expect,it } from "vitest";
import { database,closeDatabase } from "../database.js";
import { sharedTaskRepository as tasks } from "../shared-task-repository.js";
import { createTwoSpaceFixture,twoSpaceMemoryAuthorization,type TwoSpaceFixture } from "../spaces/two-space-fixture.js";
import { reminderRepository as reminders } from "./reminder-repository.js";
import { reminderDispatchRepository as dispatch } from "./reminder-dispatch-repository.js";
import { dailyOverviewRepository } from "../initiative/daily-overview-repository.js";
const enabled=process.env.RUN_DATABASE_INTEGRATION_TESTS==="true";
if(enabled&&!new URL(process.env.DATABASE_URL!).pathname.endsWith("_test"))throw new Error("AGENT_TEST_DATABASE_UNSAFE");
let f:TwoSpaceFixture;
const personal=(who:TwoSpaceFixture["owner"])=>({familyId:f.familyId,userId:who.userId,role:"member" as const,
  telegramChatId:who.telegramUserId,telegramChatType:"private" as const,groupId:null,groupType:null,forumTopicId:null,messageThreadId:null});
async function request() {
  const auth=await twoSpaceMemoryAuthorization({fixture:f,as:f.owner,chat:"group",spaceId:f.pairSpaceId});
  const people=(await tasks.execute(auth,{action:"participants"},"people")).participants!;
  return (await tasks.execute(auth,{action:"create",title:"Выбрать день поездки",assigneeRef:people.find(p=>p.name==="Супруга")!.participantRef},"request")).task!;
}
(enabled?describe:describe.skip)("request followup",()=>{
  beforeEach(async()=>{await database().query("TRUNCATE families,users CASCADE");f=await createTwoSpaceFixture("followup");});
  afterAll(closeDatabase);
  it("sends the author one personal signal while proposed, then stops after acceptance",async()=>{
    const task=await request(),auth=personal(f.owner),due=new Date(Date.now()+60000);
    await reminders.configureNotifications(auth,{timezone:"UTC",quietStart:null,quietEnd:null});
    await reminders.configureNotifications(personal(f.spouse),{timezone:"UTC",quietStart:null,quietEnd:null});
    const reminder=await reminders.create(auth,{taskId:task.id,content:task.title,firstRunAt:due,
      scope:"personal",timezone:"UTC",recurrence:{unit:"daily",interval:1},operationKey:"followup"});
    expect(reminder).toMatchObject({taskId:task.id,taskReminderKind:"response"});
    await expect(reminders.create(personal(f.spouse),{taskId:task.id,content:task.title,firstRunAt:due,
      scope:"personal",timezone:"UTC",recurrence:null,operationKey:"not-author"})).rejects.toMatchObject({code:"AGENT_TASK_REMINDER_DENIED"});
    const jobs=await dispatch.claimDue({now:new Date(due.getTime()+1000),limit:10,leaseMilliseconds:60000});
    expect(jobs).toHaveLength(1);
    await dispatch.markDispatchStarted(jobs[0]!.id,jobs[0]!.leaseToken);
    await dispatch.complete(jobs[0]!,new Date(due.getTime()+2000),{text:task.title,messageId:"91001"});
    const spouse=await twoSpaceMemoryAuthorization({fixture:f,as:f.spouse,chat:"private",spaceId:f.pairSpaceId});
    await tasks.execute(spouse,{action:"accept",id:task.id},"accept");
    expect((await reminders.list(auth,{limit:20})).items.find(r=>r.id===reminder.id)?.status).toBe("paused");
    await expect(reminders.update(auth,reminder.id,{enabled:true,firstRunAt:new Date(Date.now()+120000),operationKey:"resume"})).rejects.toMatchObject({code:"AGENT_TASK_REMINDER_DENIED"});
    expect(await dispatch.claimDue({now:new Date(due.getTime()+86400000),limit:10,leaseMilliseconds:60000})).toEqual([]);
  });
  it("shows unanswered requests only to their author in the daily overview",async()=>{
    await request();
    const recipient=(who:TwoSpaceFixture["owner"])=>({familyId:f.familyId,userId:who.userId,telegramUserId:who.telegramUserId,firstEver:false,
      settings:{dailyLimit:3,enabled:true,quietStart:null,quietEnd:null,timezone:"UTC"},state:{sentToday:0,unanswered:0}});
    expect(await dailyOverviewRepository.overview(recipient(f.owner))).toMatchObject({waiting:[{title:"Выбрать день поездки"}]});
    expect(await dailyOverviewRepository.overview(recipient(f.spouse))).toMatchObject({waiting:[]});
  });
  it("rechecks the answer after lease and never converts a response check into execution",async()=>{
    const task=await request(),auth=personal(f.owner),due=new Date(Date.now()+60000);
    await reminders.configureNotifications(auth,{timezone:"UTC",quietStart:null,quietEnd:null});
    const reminder=await reminders.create(auth,{taskId:task.id,content:task.title,firstRunAt:due,
      scope:"personal",timezone:"UTC",recurrence:null,operationKey:"check"});
    const [job]=await dispatch.claimDue({now:new Date(due.getTime()+1000),limit:10,leaseMilliseconds:60000});
    const spouse=await twoSpaceMemoryAuthorization({fixture:f,as:f.spouse,chat:"private",spaceId:f.pairSpaceId});
    await tasks.execute(spouse,{action:"decline",id:task.id},"decline");
    await expect(dispatch.markDispatchStarted(job!.id,job!.leaseToken)).rejects.toMatchObject({code:"AGENT_REMINDER_LEASE_STALE"});
    expect((await reminders.list(auth,{limit:20})).items.find(r=>r.id===reminder.id)).toMatchObject({status:"paused",lastErrorCode:null});
    // Even a later accepted assignment to the original author is a different purpose.
    await database().query("UPDATE shared_tasks SET status='accepted',assignee_telegram_id=$2 WHERE id=$1",[task.id,f.owner.telegramUserId]);
    await expect(reminders.update(auth,reminder.id,{enabled:true,firstRunAt:new Date(Date.now()+120000),operationKey:"repurpose"})).rejects.toMatchObject({code:"AGENT_TASK_REMINDER_DENIED"});
  });
  it("does not create or dispatch a task reminder after source-space membership is revoked",async()=>{
    const task=await request(),auth=personal(f.owner),due=new Date(Date.now()+60000);
    await reminders.configureNotifications(auth,{timezone:"UTC",quietStart:null,quietEnd:null});
    await reminders.create(auth,{taskId:task.id,content:task.title,firstRunAt:due,scope:"personal",timezone:"UTC",recurrence:null,operationKey:"before-revoke"});
    await database().query("DELETE FROM space_memberships WHERE space_id=$1 AND user_id=$2",[f.pairSpaceId,f.owner.userId]);
    await expect(reminders.create(auth,{taskId:task.id,content:task.title,firstRunAt:due,scope:"personal",timezone:"UTC",recurrence:null,operationKey:"after-revoke"})).rejects.toMatchObject({code:"AGENT_TASK_REMINDER_DENIED"});
    expect(await dispatch.claimDue({now:new Date(due.getTime()+1000),limit:10,leaseMilliseconds:60000})).toEqual([]);
  });

  it("rechecks source access after a reminder has already been leased",async()=>{
    const task=await request(),auth=personal(f.owner),due=new Date(Date.now()+60000);
    await reminders.configureNotifications(auth,{timezone:"UTC",quietStart:null,quietEnd:null});
    await reminders.create(auth,{taskId:task.id,content:task.title,firstRunAt:due,scope:"personal",timezone:"UTC",recurrence:null,operationKey:"lease-revoke"});
    const [job]=await dispatch.claimDue({now:new Date(due.getTime()+1000),limit:10,leaseMilliseconds:60000});
    expect(job).toBeDefined();
    await database().query("DELETE FROM space_memberships WHERE space_id=$1 AND user_id=$2",[f.pairSpaceId,f.owner.userId]);
    await expect(dispatch.markDispatchStarted(job!.id,job!.leaseToken)).rejects.toMatchObject({code:"AGENT_TASK_REMINDER_DENIED"});
  });

});
