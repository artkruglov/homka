/** Lists and counters must use the same live audience as task content. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { database, closeDatabase } from "../database.js";
import { sharedTaskRepository as tasks } from "../shared-task-repository.js";
import { createTwoSpaceFixture, twoSpaceMemoryAuthorization, type TwoSpaceFixture } from "./two-space-fixture.js";
const enabled=process.env.RUN_DATABASE_INTEGRATION_TESTS==="true";
if(enabled && (!process.env.DATABASE_URL || !new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))) throw new Error("AGENT_TEST_DATABASE_UNSAFE");
let f:TwoSpaceFixture;
async function auth(chat:"group"|"private",owner=false){
 return twoSpaceMemoryAuthorization({as:owner?f.owner:f.spouse,chat,fixture:f,spaceId:f.pairSpaceId});
}
async function seed(space:string,title:string){
 await database().query(`INSERT INTO shared_tasks(family_id,space_id,scope,creator_telegram_id,assignee_telegram_id,title,list_name,status)
 VALUES($1,$2,'family',$3,$4,$5,'Дела','accepted')`,[f.familyId,space,f.owner.telegramUserId,f.spouse.telegramUserId,title]);
}
(enabled?describe:describe.skip)("task read audience across shared spaces",()=>{
 beforeEach(async()=>{
  await database().query("TRUNCATE families,users CASCADE");f=await createTwoSpaceFixture("task-read");
  await database().query("UPDATE family_space_runtime SET mode='spaces',cutover_at=now() WHERE family_id=$1",[f.familyId]);
  await seed(f.pairSpaceId,"Общее дело пары");await seed(f.householdSpaceId,"Закрытое дело хозяйства");
 });
 afterAll(closeDatabase);
 it("does not expose a neighbouring space in the couple group, even to its owner",async()=>{
  const result=await tasks.execute(await auth("group",true),{action:"list"},randomUUID());
  expect(result.tasks?.map(t=>t.title)).toEqual(["Общее дело пары"]);
 });
 it("does not grant private access merely because an inaccessible task was assigned to the reader",async()=>{
  const result=await tasks.execute(await auth("private"),{action:"list"},randomUUID());
  expect(result.tasks?.map(t=>t.title)).toEqual(["Общее дело пары"]);
 });
 it("counts only records visible to this audience",async()=>{
  const result=await tasks.execute(await auth("group",true),{action:"lists"},randomUUID());
  expect(result.lists).toHaveLength(1);
  expect(result.lists?.[0]).toMatchObject({itemCount:1,unfinishedItemCount:1});
 });
 it("keeps accessible same-named lists separate and removes counts immediately after revocation",async()=>{
  await database().query("UPDATE shared_tasks SET assignee_telegram_id=$2 WHERE family_id=$1",[f.familyId,f.owner.telegramUserId]);
  const before=await tasks.execute(await auth("private",true),{action:"lists"},randomUUID());
  expect(before.lists?.map(l=>l.source).sort()).toEqual(["Пара","Хозяйство"]);
  expect(before.lists?.map(l=>l.itemCount)).toEqual([1,1]);
  await database().query("DELETE FROM space_memberships WHERE space_id=$1 AND user_id=$2",[f.householdSpaceId,f.owner.userId]);
  const after=await tasks.execute(await auth("private",true),{action:"lists"},randomUUID());
  expect(after.lists).toEqual([{listName:"Дела",source:"Пара",itemCount:1,unfinishedItemCount:1}]);
 });

 it("hides removed space members and rejects their old participant reference",async()=>{
  const initial=await tasks.execute(await auth("group",true),{action:"participants"},randomUUID());
  const owned=await tasks.execute(await auth("group",true),{action:"create",title:"Моё дело"},randomUUID());
  const ref=initial.participants!.find(p=>p.name==="Супруга")!.participantRef;
  await database().query("DELETE FROM space_memberships WHERE space_id=$1 AND user_id=$2",[f.pairSpaceId,f.spouse.userId]);
  const refreshed=await tasks.execute(await auth("group",true),{action:"participants"},randomUUID());
  expect(refreshed.participants?.map(p=>p.name)).not.toContain("Супруга");
  await expect(tasks.execute(await auth("group",true),{action:"create",title:"Закрытое поручение",assigneeRef:ref},randomUUID())).rejects.toThrow(/AGENT_TASK_ACCESS_DENIED/);
  await expect(tasks.execute(await auth("group",true),{action:"transfer",id:owned.task!.id,version:owned.task!.version,assigneeRef:ref},randomUUID())).rejects.toThrow(/AGENT_TASK_ACCESS_DENIED/);
 });

});
