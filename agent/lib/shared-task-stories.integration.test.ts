/**
 * Planner user stories against real PostgreSQL (docs/task-user-stories.ru.md).
 *
 * Each test name starts with the story it proves: T01 capture on the go, T02 personal
 * view and the separate "Завершённые", T03 a shared task without an assignee in the
 * family group, T05/T06 closing from private and stopping signals.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
const currentMember = vi.hoisted(()=>vi.fn(async()=>true));
vi.mock('./telegram-current-membership.js',()=>({isCurrentTelegramMember:currentMember}));
import { closeDatabase, database } from "./database.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { reminderRepository } from "./reminders/reminder-repository.js";
import { sharedTaskRepository as tasks } from "./shared-task-repository.js";
import { createTaskFamilyFixture, makeTask } from "./shared-task.integration-fixtures.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw Error("Unsafe test database");
const suite = enabled ? describe : describe.skip;
let owner: MemoryAuthorization, member: MemoryAuthorization, familyGroup: MemoryAuthorization;

suite('planner user stories',()=>{
  beforeEach(async()=>{
    currentMember.mockResolvedValue(true);
    ({owner,member,familyGroup}=await createTaskFamilyFixture());
  });
  afterAll(closeDatabase);
  it('T02: list shows only unfinished work by default and keeps closed work in view done',async()=>{
    const open=await makeTask(owner,'Повесить шторы');
    const done=await makeTask(owner,'Скинуть документы');
    const dropped=await makeTask(owner,'Старая идея дела');
    await tasks.execute(owner,{action:'complete',id:done.id},'close-done');
    await tasks.execute(owner,{action:'cancel',id:dropped.id},'close-dropped');
    const unfinished=(await tasks.execute(owner,{action:'list'},'read')).tasks!;
    expect(unfinished.map(t=>t.id)).toEqual([open.id]);
    const closed=(await tasks.execute(owner,{action:'list',view:'done'} as never,'read')).tasks!;
    expect(closed.map(t=>t.status).sort()).toEqual(['cancelled','completed']);
    expect((await tasks.execute(owner,{action:'list',status:'completed'},'read')).tasks!.map(t=>t.id)).toEqual([done.id]);
  });
  it('T02: list rows are compact and get returns the full record of a visible task',async()=>{
    const task=(await tasks.execute(owner,{action:'create',title:'Продать опель',details:'Сначала починить и зарядить аккумулятор'},'create')).task!;
    const row=(await tasks.execute(owner,{action:'list'},'read')).tasks![0]!;
    expect(row).toMatchObject({id:task.id,title:'Продать опель',status:'accepted',version:task.version});
    for (const heavy of ['details','originalText','careAreaRef','commitment']) expect(row).not.toHaveProperty(heavy);
    const full=(await tasks.execute(owner,{action:'get',id:task.id} as never,'read')).task!;
    expect(full).toMatchObject({id:task.id,details:'Сначала починить и зарядить аккумулятор',originalText:{title:'Продать опель'}});
    await expect(tasks.execute(member,{action:'get',id:task.id} as never,'read')).rejects.toThrow(/AGENT_TASK_ACCESS_DENIED/);
  });

  it('T01: a dictated list becomes several tasks in one call and replays by its key',async()=>{
    const input={action:'batch',items:[{action:'create',title:'Найти людей повесить шторы'},{action:'create',title:'Продать опель'},
      {action:'create',title:'Отвезти матрас и свет в новую квартиру'}]} as never;
    const created=await tasks.execute(owner,input,'dictated');
    expect(created.replayed).toBe(false);
    expect(created.tasks!.map(t=>t.title)).toEqual(['Найти людей повесить шторы','Продать опель','Отвезти матрас и свет в новую квартиру']);
    expect(created.tasks!.every(t=>t.status==='accepted')).toBe(true);
    const again=await tasks.execute(owner,input,'dictated');
    expect(again.replayed).toBe(true);
    expect(again.tasks!.map(t=>t.id)).toEqual(created.tasks!.map(t=>t.id));
    await expect(tasks.execute(owner,{action:'batch',items:[{action:'create',title:'Другое'}]} as never,'dictated')).rejects.toThrow(/AGENT_TASK_ACCESS_DENIED/);
    expect((await tasks.execute(owner,{action:'list'},'read')).tasks).toHaveLength(3);
  });
  it('T03: a batch in the family group creates family tasks the author then sees in private',async()=>{
    const created=await tasks.execute(familyGroup,{action:'batch',items:[{action:'create',title:'Шторы'},{action:'create',title:'Кто заберёт посылку',unassigned:true}]} as never,'family-list');
    const rows=(await database().query("SELECT title,scope,status,group_id FROM shared_tasks ORDER BY title")).rows;
    expect(rows).toEqual([{title:'Кто заберёт посылку',scope:'family',status:'open',group_id:null},{title:'Шторы',scope:'family',status:'accepted',group_id:null}]);
    expect((await tasks.execute(familyGroup,{action:'list'},'read')).tasks!.map(t=>t.title).sort()).toEqual(['Кто заберёт посылку','Шторы']);
    expect((await tasks.execute(owner,{action:'list'},'read')).tasks!.map(t=>t.id)).toEqual([created.tasks![0]!.id]);
  });
  it('T05/T06: closing several tasks in one call pauses their signals and records a version for each',async()=>{
    const [a,b,c]=[await makeTask(owner,'Документы'),await makeTask(owner,'Антон'),await makeTask(owner,'Остаётся')];
    const auth={familyId:owner.familyId,userId:owner.userId!,role:'owner' as const,telegramChatId:owner.telegramUserId!,telegramChatType:'private' as const,
      groupId:null,groupType:null,forumTopicId:null,messageThreadId:null};
    await reminderRepository.configureNotifications(auth,{timezone:'Europe/Moscow',quietStart:null,quietEnd:null});
    const due=new Date(Date.now()+86_400_000);
    for (const task of [a,b]) await reminderRepository.create(auth,{taskId:task.id,content:task.title,firstRunAt:due,recurrence:null,scope:'personal',
      timezone:'Europe/Moscow',operationKey:`signal-${task.title}`});
    const closed=await tasks.execute(owner,{action:'batch',items:[{action:'complete',id:b.id},{action:'complete',id:a.id}]} as never,'close-two');
    expect(closed.tasks!.map(t=>[t.id,t.status])).toEqual([[b.id,'completed'],[a.id,'completed']]);
    expect((await database().query("SELECT status FROM reminders ORDER BY status")).rows.map(r=>r.status)).toEqual(['paused','paused']);
    expect((await database().query("SELECT count(*)::int n FROM shared_task_versions WHERE action='complete'")).rows[0].n).toBe(2);
    expect((await tasks.execute(owner,{action:'list'},'read')).tasks!.map(t=>t.id)).toEqual([c.id]);
  });
  it('edits and plans several tasks in one batch, and one stale version stops all of them',async()=>{
    // Прод 14 сентября: один ход потратил 18 подряд `update`, потому что правка не шла в пакет.
    const [a,b]=[await makeTask(owner,'Отвезти матрас'),await makeTask(owner,'Зарядить аккумулятор')];
    const edited=await tasks.execute(owner,{action:'batch',items:[
      {action:'update',id:a.id,version:a.version,listName:'Переезд'},
      {action:'update',id:b.id,version:b.version,title:'Зарядить аккумулятор опеля'},
    ]} as never,'edit-two');
    expect(edited.tasks!.map(t=>t.title)).toEqual(['Отвезти матрас','Зарядить аккумулятор опеля']);
    expect((await database().query("SELECT count(*)::int n FROM shared_task_versions WHERE action='update'")).rows[0].n).toBe(2);
    const planned=await tasks.execute(owner,{action:'batch',items:[
      {action:'plan',id:a.id,plannedFrom:'2026-09-23',plannedUntil:'2026-09-24'},
      {action:'plan',id:b.id,plannedFrom:'2026-09-25',plannedUntil:'2026-09-25'},
    ]} as never,'plan-two');
    expect(planned.tasks!.length).toBe(2);
    expect((await database().query("SELECT count(*)::int n FROM shared_task_plans")).rows[0].n).toBe(2);
    // Версия одного пункта устарела после правки: весь пакет откатывается, как и у закрытий.
    const stale=tasks.execute(owner,{action:'batch',items:[
      {action:'update',id:a.id,version:a.version,title:'Не должно примениться'},
      {action:'update',id:b.id,version:b.version+1,title:'И это тоже'},
    ]} as never,'stale-edit');
    await expect(stale).rejects.toThrow(/AGENT_TASK_BATCH_REJECTED/);
    await expect(stale).rejects.toThrow(/#1 AGENT_TASK_VERSION_CONFLICT/);
    expect((await database().query("SELECT title FROM shared_tasks ORDER BY title")).rows.map(r=>r.title))
      .toEqual(['Зарядить аккумулятор опеля','Отвезти матрас']);
  });
  it('rejects the whole batch and names every failing item when one change is not allowed',async()=>{
    const own=await makeTask(owner,'Моё дело');
    const foreign=await makeTask(member,'Чужое дело');
    const missing='aaaaaaaa-aaaa-4aaa-8aaa-000000000009';
    const attempt=tasks.execute(owner,{action:'batch',items:[{action:'complete',id:own.id},{action:'complete',id:foreign.id},
      {action:'create',title:'Новое'},{action:'cancel',id:missing}]} as never,'mixed');
    await expect(attempt).rejects.toThrow(/AGENT_TASK_BATCH_REJECTED/);
    await expect(attempt).rejects.toThrow(/#2 AGENT_TASK_ACCESS_DENIED/);
    await expect(attempt).rejects.toThrow(/#4 AGENT_TASK_ACCESS_DENIED/);
    expect((await database().query("SELECT title,status FROM shared_tasks ORDER BY title")).rows)
      .toEqual([{title:'Моё дело',status:'accepted'},{title:'Чужое дело',status:'accepted'}]);
    expect((await database().query("SELECT count(*)::int n FROM shared_task_operations WHERE operation_key LIKE 'mixed%'")).rows[0].n).toBe(0);
  });
  it('lets two batches over the same tasks finish without a deadlock',async()=>{
    const [a,b]=[await makeTask(owner,'A'),await makeTask(owner,'B')];
    const results=await Promise.allSettled([
      tasks.execute(owner,{action:'batch',items:[{action:'complete',id:a.id},{action:'complete',id:b.id}]} as never,'first'),
      tasks.execute(owner,{action:'batch',items:[{action:'cancel',id:b.id},{action:'cancel',id:a.id}]} as never,'second')]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    const rejected=results.find(r=>r.status==='rejected') as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/AGENT_TASK_BATCH_REJECTED/);
  });
  it('T05: a status change carrying a stale version is refused and changes nothing',async()=>{
    const task=await makeTask(owner,'Документы');
    await expect(tasks.execute(owner,{action:'complete',id:task.id,version:task.version+1} as never,'stale')).rejects.toThrow(/AGENT_TASK_VERSION_CONFLICT/);
    expect((await tasks.execute(owner,{action:'complete',id:task.id,version:task.version} as never,'fresh')).task?.status).toBe('completed');
  });
  it('T05: a task closed by mistake returns to work with its history and its future signal, never an old one',async()=>{
    const task=await makeTask(owner,'Сканировать документы');
    const auth={familyId:owner.familyId,userId:owner.userId!,role:'owner' as const,telegramChatId:owner.telegramUserId!,telegramChatType:'private' as const,
      groupId:null,groupType:null,forumTopicId:null,messageThreadId:null};
    await reminderRepository.configureNotifications(auth,{timezone:'Europe/Moscow',quietStart:null,quietEnd:null});
    await reminderRepository.create(auth,{taskId:task.id,content:task.title,firstRunAt:new Date(Date.now()+86_400_000),recurrence:null,
      scope:'personal',timezone:'Europe/Moscow',operationKey:'scan-signal'});
    await tasks.execute(owner,{action:'batch',items:[{action:'complete',id:task.id}]} as never,'close-by-mistake');
    const reopened=(await tasks.execute(owner,{action:'reopen',id:task.id} as never,'reopen')).task!;
    expect(reopened).toMatchObject({id:task.id,status:'accepted'});
    expect((await database().query("SELECT action FROM shared_task_versions WHERE task_id=$1 ORDER BY version",[task.id])).rows.map(r=>r.action))
      .toEqual(['complete','reopen']);
    // Сигнал на завтра возвращается вместе с делом, прошедший остаётся на паузе.
    expect((await database().query("SELECT status FROM reminders WHERE shared_task_id=$1",[task.id])).rows[0].status).toBe('active');
    await tasks.execute(owner,{action:'batch',items:[{action:'complete',id:task.id}]} as never,'close-again');
    await database().query("UPDATE reminders SET available_at=now()-interval '1 day' WHERE shared_task_id=$1",[task.id]);
    await tasks.execute(owner,{action:'reopen',id:task.id} as never,'reopen-past');
    expect((await database().query("SELECT status FROM reminders WHERE shared_task_id=$1",[task.id])).rows[0].status).toBe('paused');
    expect((await tasks.execute(owner,{action:'list'},'read')).tasks!.map(t=>t.id)).toContain(task.id);
  });
  it('lets only the people of a task reopen it and never reopens a declined request',async()=>{
    const own=await makeTask(owner,'Моё');
    await tasks.execute(owner,{action:'cancel',id:own.id},'cancel-own');
    await expect(tasks.execute(member,{action:'reopen',id:own.id} as never,'stranger')).rejects.toThrow(/AGENT_TASK_ACCESS_DENIED/);
    expect((await tasks.execute(owner,{action:'reopen',id:own.id} as never,'reopen-own')).task?.status).toBe('accepted');
    await expect(tasks.execute(owner,{action:'reopen',id:own.id} as never,'reopen-again')).rejects.toThrow(/AGENT_TASK_TRANSITION_DENIED/);
  });
});
