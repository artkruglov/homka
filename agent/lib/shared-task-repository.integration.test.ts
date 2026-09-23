/** Real PostgreSQL tests for assignments, isolation, revocation and concurrent acceptance. */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
const currentMember = vi.hoisted(()=>vi.fn(async()=>true));
vi.mock('./telegram-current-membership.js',()=>({isCurrentTelegramMember:currentMember}));
import { reminderRepository } from "./reminders/reminder-repository.js";
import { reminderDispatchRepository } from "./reminders/reminder-dispatch-repository.js";
import { randomUUID } from "node:crypto";
import { database, closeDatabase } from "./database.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { sharedTaskRepository as tasks } from "./shared-task-repository.js";
import { recordVerifiedHumanTelegramMessage } from "./telegram-group-journal.integration-fixtures.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw Error("Unsafe test database");
const suite = enabled ? describe : describe.skip;
let owner: MemoryAuthorization, member: MemoryAuthorization, group: MemoryAuthorization, secondGroup: MemoryAuthorization;
let familyGroup: MemoryAuthorization, familyMember: MemoryAuthorization;

async function fixture() {
  const family = (await database().query("INSERT INTO families(name) VALUES('Tasks') RETURNING id")).rows[0].id;
  const people = (await database().query(`INSERT INTO users(telegram_user_id,display_name)
    VALUES('700101','Owner'),('700102','Member') RETURNING id,telegram_user_id`)).rows;
  for (const p of people) await database().query("INSERT INTO family_memberships(family_id,user_id,role) VALUES($1,$2,$3)",
    [family,p.id,p.telegram_user_id==='700101'?'owner':'member']);
  const auth = (who: string): MemoryAuthorization => ({ familyId: family, groupId: null, scopes: ['personal','family'],
    role: who==='700101'?'owner':'member', userId: people.find(p=>p.telegram_user_id===who).id,
    telegramActorKind:'telegram_user',telegramActorId:who,telegramUserId:who });
  owner=auth('700101'); member=auth('700102');
  const groups = (await database().query(`INSERT INTO telegram_groups(family_id,telegram_chat_id,title,type,tool_allowlist,message_mode)
    VALUES($1,'-101','Ilya','external',ARRAY['manage_shared_tasks'],'addressed_only'),
    ($1,'-102','Mom','external',ARRAY['manage_shared_tasks'],'addressed_only'),
    ($1,'-103','Family','family_private','{}','addressed_only') RETURNING id,title`,[family])).rows;
  group={...owner,groupId:groups.find(g=>g.title==='Ilya').id,scopes:['group']};
  secondGroup={...owner,groupId:groups.find(g=>g.title==='Mom').id,scopes:['group']};
  familyGroup={...owner,groupId:groups.find(g=>g.title==='Family').id,scopes:['family']};
  familyMember={...member,groupId:familyGroup.groupId,scopes:['family']};
}
async function make(auth: MemoryAuthorization, title: string, assigneeRef?: string) {
  const result = await tasks.execute(auth,{action:'create',title,...(assigneeRef?{assigneeRef}:{})},randomUUID());
  return result.task!;
}

suite('shared task repository',()=>{
  beforeEach(async()=>{
    currentMember.mockResolvedValue(true);
    await database().query('TRUNCATE families,users CASCADE');
    await fixture();
  });
  afterAll(closeDatabase);
  it('clarifies an inbox item without losing its original wording or making a duplicate',async()=>{
    const task=(await tasks.execute(owner,{action:'create',title:'Разобраться с выходными',kind:'idea',details:'Может бассейн, пока не знаю'},'capture')).task!;
    expect((await tasks.execute(owner,{action:'list',view:'inbox'} as never,'read')).tasks?.map(t=>t.id)).toContain(task.id);
    const input={action:'clarify',id:task.id,version:task.version,title:'Узнать часы семейного бассейна',details:'Сначала проверить расписание'} as never;
    const clarified=await tasks.execute(owner,input,'clarify');
    expect(clarified.task).toMatchObject({id:task.id,kind:'idea',originalText:{title:'Разобраться с выходными',details:'Может бассейн, пока не знаю'}});
    expect((await tasks.execute(owner,input,'clarify')).replayed).toBe(true);
    expect((await tasks.execute(owner,{action:'list',view:'inbox'} as never,'read')).tasks).toEqual([]);
    expect((await tasks.execute(member,{action:'list',view:'inbox'} as never,'read')).tasks).toEqual([]);
    await tasks.execute(owner,{action:'update',id:task.id,version:clarified.task!.version,title:'Посмотреть бассейн рядом'},'edit');
    expect((await tasks.execute(owner,{action:'get',id:task.id} as never,'read')).task).toMatchObject({originalText:{title:'Разобраться с выходными'}});
    expect((await database().query('SELECT count(*)::int AS n FROM shared_tasks')).rows[0].n).toBe(1);
  });
  it('filters by a life area the person named, and leaves unlabelled tasks alone',async()=>{
    // Шесть представлений из документа о балансе существовали только на бумаге: в коде был один
    // плоский список.
    const own=(await tasks.execute(owner,{action:'create',title:'Записаться на йогу',lifeArea:'self'} as never,'self')).task!;
    await tasks.execute(owner,{action:'create',title:'Купить фильтры',lifeArea:'home'} as never,'home');
    const plain=(await tasks.execute(owner,{action:'create',title:'Отвезти машину'} as never,'plain')).task!;

    expect(own).toMatchObject({lifeArea:'self'});
    expect(plain.lifeArea).toBeNull();
    const mine=(await tasks.execute(owner,{action:'list',view:'self'} as never,'read')).tasks!;
    expect(mine.map(t=>t.title)).toEqual(['Записаться на йогу']);
    expect((await tasks.execute(owner,{action:'list',lifeArea:'home'} as never,'read')).tasks!.map(t=>t.title))
      .toEqual(['Купить фильтры']);
    // Метку можно снять и поставить заново; чужих сфер в схеме нет.
    const cleared=(await tasks.execute(owner,{action:'update',id:own.id,version:own.version,lifeArea:null} as never,'clear')).task!;
    expect(cleared.lifeArea).toBeNull();
    await expect(tasks.execute(owner,{action:'create',title:'Хобби',lifeArea:'hobby'} as never,'bad'))
      .rejects.toThrow(/AGENT_TASK_INPUT_INVALID/);
  });
  it('projects only my assignments into my private overview with their source',async()=>{
    const privateTask=await make(owner,'Private');
    const groupTask=await make(group,'Group');
    await make(member,'Other personal');
    await make(secondGroup,'Mom');
    const overview=await tasks.execute(owner,{action:'list'},'read');
    expect(overview.tasks?.map(t=>t.title).sort()).toEqual(['Group','Mom','Private']);
    expect(overview.tasks?.find(t=>t.id===groupTask.id)?.source).toBe('Ilya');
    expect((await tasks.execute(group,{action:'list'},'read')).tasks?.map(t=>t.id)).toEqual([groupTask.id]);
    await expect(tasks.execute(group,{action:'complete',id:privateTask.id},'attack')).rejects.toThrow(/AGENT_TASK_ACCESS_DENIED/);
    await expect(tasks.execute(secondGroup,{action:'complete',id:groupTask.id},'attack')).rejects.toThrow(/AGENT_TASK_ACCESS_DENIED/);
  });
  it('does not reveal a personal plan through the group inbox and keeps clarification author rights',async()=>{
    const task=await make(familyGroup,'Подумать о поездке');
    await tasks.execute(owner,{action:'plan',id:task.id,plannedFrom:'2026-10-01',plannedUntil:'2026-10-02'},'my-plan');
    expect((await tasks.execute(owner,{action:'list',view:'inbox'},'read')).tasks).toEqual([]);
    expect((await tasks.execute(familyMember,{action:'list',view:'inbox'},'read')).tasks?.map(t=>t.id)).toContain(task.id);
    await expect(tasks.execute(familyMember,{action:'clarify',id:task.id,version:task.version,title:'Другое'},'foreign-clarify')).rejects.toMatchObject({code:'AGENT_TASK_ACCESS_DENIED'});
    const clarified=await tasks.execute(owner,{action:'clarify',id:task.id,version:task.version},'mine-clarify');
    expect(clarified.task?.version).toBe(task.version+1);
    await expect(tasks.execute(owner,{action:'clarify',id:task.id,version:task.version},'stale-clarify')).rejects.toMatchObject({code:'AGENT_TASK_VERSION_CONFLICT'});
  });
  it('requires the recipient to accept and finish a proposed family task',async()=>{
    const recipients=(await tasks.execute(familyGroup,{action:'participants'},'read')).participants!;
    const ref=recipients.find(p=>p.name==='Member')!.participantRef;
    const task=await make(familyGroup,'Buy milk',ref);
    expect(task.status).toBe('proposed');
    expect((await tasks.execute(member,{action:'list',status:'accepted'},'read')).tasks).toEqual([]);
    await expect(tasks.execute(familyGroup,{action:'accept',id:task.id},'wrong')).rejects.toThrow(/AGENT_TASK_TRANSITION_DENIED/);
    const accepted=await tasks.execute(member,{action:'accept',id:task.id},'accept');
    expect(accepted.task?.status).toBe('accepted');
    const replay=await tasks.execute(member,{action:'accept',id:task.id},'accept');
    expect(replay.replayed).toBe(true);
    expect((await tasks.execute(member,{action:'complete',id:task.id},'done')).task?.status).toBe('completed');
    expect((await tasks.execute(familyGroup,{action:'list',view:'done'} as never,'read')).tasks?.[0]?.status).toBe('completed');
  });
  it('lets an observed external participant propose a task to a family member, without accepting for them',async()=>{
    await recordVerifiedHumanTelegramMessage(group.groupId!, {
      messageId:'1',chat:{id:'-101',type:'group'},attachments:[],caption:'',
      raw:{date:Math.floor(Date.now()/1000)},from:{id:'700101',isBot:false,firstName:'Owner'},text:'Hello',
    });
    const external:MemoryAuthorization={...group,userId:null,role:'external',telegramUserId:'700103',telegramActorId:'700103'};
    const people=(await tasks.execute(external,{action:'participants'},'read')).participants!;
    expect(people.map(p=>p.name)).toContain('Owner');
    const task=await make(external,'Book a table',people.find(p=>p.name==='Owner')!.participantRef);
    expect(task.status).toBe('proposed');
    await expect(tasks.execute(external,{action:'accept',id:task.id},'wrong')).rejects.toThrow();
    expect((await tasks.execute(owner,{action:'accept',id:task.id},'yes')).task?.status).toBe('accepted');
    currentMember.mockResolvedValue(false);
    await expect(make(external,'New information',people[0]!.participantRef)).rejects.toThrow(/AGENT_TASK_ACCESS_DENIED/);
  });
  it('rechecks membership and group policy including on replay',async()=>{
    const task=await make(group,'Task');
    await database().query("UPDATE telegram_groups SET tool_allowlist='{}' WHERE id=$1",[group.groupId]);
    await expect(tasks.execute(group,{action:'list'},'read')).rejects.toThrow(/AGENT_TASK_ACCESS_DENIED/);
    await database().query('DELETE FROM family_memberships WHERE user_id=$1',[owner.userId]);
    await expect(tasks.execute(owner,{action:'complete',id:task.id},'done')).rejects.toThrow(/AGENT_TASK_ACCESS_DENIED/);
  });
  it('rejects another family and channel actors',async()=>{
    const task=await make(owner,'Secret');
    await expect(tasks.execute({...owner,familyId:randomUUID()},{action:'list'},'read')).rejects.toThrow();
    await expect(tasks.execute({...group,telegramActorKind:'telegram_channel'},{action:'create',title:'Spoof'},'bad')).rejects.toThrow();
    await expect(tasks.execute(member,{action:'complete',id:task.id},'bad')).rejects.toThrow();
  });
  it('serializes duplicate creation and conflicting terminal transitions',async()=>{
    const input={action:'create' as const,title:'Once'};
    const results=await Promise.all([tasks.execute(owner,input,'same'),tasks.execute(owner,input,'same')]);
    expect(results[0].task?.id).toBe(results[1].task?.id);
    expect((await tasks.execute(owner,{action:'list'},'read')).tasks).toHaveLength(1);
    await expect(tasks.execute(owner,{...input,title:'Changed'},'same')).rejects.toThrow();
    const id=results[0].task!.id;
    const transitions=await Promise.allSettled([
      tasks.execute(owner,{action:'complete',id},'finish'),tasks.execute(owner,{action:'cancel',id},'cancel')]);
    expect(transitions.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  });
  it('does not allow a family participant ref in a different group',async()=>{
    const ref=(await tasks.execute(familyGroup,{action:'participants'},'read')).participants![0]!.participantRef;
    await expect(make(group,'Wrong space',ref)).rejects.toThrow(/AGENT_TASK_ACCESS_DENIED/);
  });
  it('keeps ideas and rituals free of obligations while retaining separate personal plans',async()=>{
    const idea=(await tasks.execute(familyGroup,{action:'create',title:'Learn pottery',kind:'idea',listName:'For us'},'idea')).task!;
    expect(idea.commitment).toBe(false);
    await expect(tasks.execute(familyGroup,{action:'complete',id:idea.id},'not-an-obligation')).rejects.toThrow();
    await tasks.execute(familyGroup,{action:'plan',id:idea.id,plannedFrom:'2026-10-01',plannedUntil:'2026-10-31'},'my-plan');
    const other={...familyGroup,...member,groupId:familyGroup.groupId,scopes:['family'] as const};
    expect((await tasks.execute({...other,scopes:['family']},{action:'list'},'read')).tasks![0]!.plannedFrom).toBeNull();
    expect((await tasks.execute(familyGroup,{action:'list'},'read')).tasks![0]!.plannedFrom).toBeNull();
    await expect(tasks.execute(familyGroup,{action:'list',view:'planned'},'private-plan-in-group')).rejects.toThrow(/AGENT_TASK_ACCESS_DENIED/);
    await expect(tasks.execute(familyGroup,{action:'list',from:'2026-10-01',until:'2026-10-31'},'private-range-in-group')).rejects.toThrow(/AGENT_TASK_ACCESS_DENIED/);
    expect((await tasks.execute(owner,{action:'list',view:'planned',from:'2026-10-15',until:'2026-10-15'},'read')).tasks).toHaveLength(1);
    expect((await tasks.execute(owner,{action:'list',view:'planned',from:'2026-11-01',until:'2026-11-30'},'read')).tasks).toHaveLength(0);
    await tasks.execute(owner,{action:'activate',id:idea.id,version:idea.version},'make-real');
    expect((await tasks.execute(owner,{action:'list'},'read')).tasks![0]!.kind).toBe('task');
    const ritual=(await tasks.execute(group,{action:'create',kind:'ritual',title:'Sunday tea'},'ritual')).task!;
    await tasks.execute(group,{action:'record',id:ritual.id,occurredOn:'2026-09-10',note:'Enjoyed the conversation'},'experience');
    expect((await tasks.execute(group,{action:'history',id:ritual.id},'read')).occurrences).toHaveLength(1);
    await expect(tasks.execute(secondGroup,{action:'history',id:ritual.id},'read')).rejects.toThrow();
  });
  it('keeps an unclaimed task waiting for its author and gives it to exactly one taker',async()=>{
    const open=await tasks.execute(familyGroup,{action:'create',title:'Кто заберёт посылку',unassigned:true},randomUUID());
    expect(open.task).toMatchObject({status:'open',assignee:null});

    // «Кто возьмёт» не назначает автора: дело остаётся в его ожиданиях, а не в его делах.
    expect((await tasks.execute(familyGroup,{action:'list',view:'mine'},'read')).tasks?.map(t=>t.id)).not.toContain(open.task!.id);
    expect((await tasks.execute(familyGroup,{action:'list',view:'waiting'},'read')).tasks?.map(t=>t.id)).toContain(open.task!.id);
    expect((await tasks.execute(familyGroup,{action:'list',view:'open'},'read')).tasks?.map(t=>t.id)).toEqual([open.task!.id]);

    // Взять свободное дело можно там, где его видно: в области, которой задан вопрос.
    await expect(tasks.execute(member,{action:'claim',id:open.task!.id},randomUUID()))
      .rejects.toThrow(/AGENT_TASK_ACCESS_DENIED/);
    const taken=await tasks.execute(familyMember,{action:'claim',id:open.task!.id},randomUUID());
    expect(taken.task).toMatchObject({status:'accepted',assignee:'Member'});
    // Второй «беру» приходит к уже занятому делу и получает отказ, а не тихо переписывает его.
    await expect(tasks.execute(familyGroup,{action:'claim',id:open.task!.id},randomUUID()))
      .rejects.toThrow(/AGENT_TASK_TRANSITION_DENIED/);
    expect((await tasks.execute(familyMember,{action:'list',view:'mine'},'read')).tasks?.map(t=>t.title)).toContain('Кто заберёт посылку');
  });

  it('refuses an unclaimed task where it would have no audience to take it',async()=>{
    await expect(tasks.execute(owner,{action:'create',title:'Личное без исполнителя',unassigned:true},randomUUID()))
      .rejects.toThrow(/AGENT_TASK_INPUT_INVALID|AGENT_TASK_ACCESS_DENIED/);
    await expect(tasks.execute(familyGroup,{action:'create',title:'Идея без исполнителя',kind:'idea',unassigned:true},randomUUID()))
      .rejects.toThrow(/AGENT_TASK_INPUT_INVALID/);
    const assigned=await make(familyGroup,'Обычное дело');
    await expect(tasks.execute(familyMember,{action:'claim',id:assigned.id},randomUUID()))
      .rejects.toThrow(/AGENT_TASK_TRANSITION_DENIED/);
  });

  it('names every list of the area and keeps same-named lists of different chats apart',async()=>{
    // Имена списков собирались с текущей страницы выдачи, поэтому при непустом курсоре часть
    // списков исчезала: страница это про дела, а не про списки.
    for (let index=0; index<101; index+=1) {
      await tasks.execute(familyGroup,{action:'create',title:`Дело ${index}`,listName:'Ремонт'},randomUUID());
    }
    await tasks.execute(familyGroup,{action:'create',title:'Молоко',listName:'Покупки'},randomUUID());
    const familyLists=await tasks.execute(familyGroup,{action:'lists'},'read');
    expect(familyLists.lists?.map(item=>item.listName).sort()).toEqual(['Покупки','Ремонт']);
    expect(familyLists.lists?.find(item=>item.listName==='Ремонт')).toMatchObject({itemCount:101,unfinishedItemCount:101});
    const first=(await tasks.execute(familyGroup,{action:'list',listName:'Ремонт'},'read')).tasks![0]!;
    await tasks.execute(familyGroup,{action:'complete',id:first.id},randomUUID());
    const afterCompletion=await tasks.execute(familyGroup,{action:'lists'},'read');
    expect(afterCompletion.lists?.find(item=>item.listName==='Ремонт')).toMatchObject({itemCount:101,unfinishedItemCount:100});

    // Одинаковое имя в разных чатах — это разные списки, и выдача обязана их различать.
    await tasks.execute(group,{action:'create',title:'Батарейки',listName:'Покупки'},randomUUID());
    const mine=await tasks.execute(owner,{action:'lists'},'read');
    expect(mine.lists?.filter(item=>item.listName==='Покупки').map(item=>item.source).sort())
      .toEqual(['Ilya','Семья']);

    // Отзыв доступа действует сразу: имя списка и название чужого чата раскрывают не меньше,
    // чем само дело, и после выхода из группы их видеть нельзя.
    currentMember.mockResolvedValue(false);
    const afterRevocation=await tasks.execute(owner,{action:'lists'},'read');
    expect(afterRevocation.lists?.map(item=>item.source)).not.toContain('Ilya');
    expect(afterRevocation.lists?.map(item=>item.listName)).toContain('Покупки');
  });

  it('answers what is due today, puts the overdue first and leaves the rest out',async()=>{
    await database().query(
      `INSERT INTO user_notification_settings(user_id,timezone,quiet_start,quiet_end)
       SELECT id,'Europe/Moscow',NULL,NULL FROM users WHERE telegram_user_id='700101'`);
    const today=new Date();
    const local=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow'}).format(today);
    const day=(shift:number)=>{
      const value=new Date(local+'T00:00:00Z');
      value.setUTCDate(value.getUTCDate()+shift);
      return value.toISOString().slice(0,10);
    };
    const overdue=await tasks.execute(owner,{action:'create',title:'Просрочено',dueOn:day(-1)},randomUUID());
    const due=await tasks.execute(owner,{action:'create',title:'Сегодня',dueOn:day(0)},randomUUID());
    const later=await tasks.execute(owner,{action:'create',title:'Потом',dueOn:day(3)},randomUUID());
    const planned=await make(owner,'Запланировано на сегодня');
    await tasks.execute(owner,{action:'plan',id:planned.id,plannedFrom:day(0),plannedUntil:day(0)},randomUUID());
    await tasks.execute(owner,{action:'complete',id:(await make(owner,'Уже сделано')).id},randomUUID());

    const day_= await tasks.execute(owner,{action:'list',view:'today'},'read');
    // Просроченное идёт первым: это то, что уже подвело, а не то, что предстоит.
    expect(day_.tasks?.map(task=>task.title)).toEqual([
      'Просрочено','Сегодня','Запланировано на сегодня',
    ]);
    expect(day_.tasks?.map(task=>task.id)).not.toContain(later.task!.id);
    expect([overdue.task!.id,due.task!.id].every(id=>day_.tasks?.some(task=>task.id===id))).toBe(true);
  });

  it('separates what I promised from what I am waiting for',async()=>{
    const recipients=(await tasks.execute(familyGroup,{action:'participants'},'read')).participants!;
    const toMember=await make(familyGroup,'Купить билеты',recipients.find(p=>p.name==='Member')!.participantRef);
    await tasks.execute(member,{action:'accept',id:toMember.id},randomUUID());
    const mine=await make(familyGroup,'Моё собственное дело');

    // «Что я обещал» это то, что поручил мне другой, а не всё назначенное на меня.
    const promised=await tasks.execute(member,{action:'list',view:'promised'},'read');
    expect(promised.tasks?.map(t=>t.title)).toEqual(['Купить билеты']);
    // Автор видит то же дело с другой стороны: он его ждёт.
    const waiting=await tasks.execute(owner,{action:'list',view:'waiting'},'read');
    expect(waiting.tasks?.map(t=>t.title)).toContain('Купить билеты');
    expect(waiting.tasks?.map(t=>t.id)).not.toContain(mine.id);
    expect((await tasks.execute(owner,{action:'list',view:'promised'},'read')).tasks).toEqual([]);
  });

  it('keeps the responsibility until the other person accepts it',async()=>{
    const recipients=(await tasks.execute(familyGroup,{action:'participants'},'read')).participants!;
    const memberRef=recipients.find(p=>p.name==='Member')!.participantRef;
    const ownerRef=recipients.find(p=>p.name==='Owner')!.participantRef;
    const task=await make(familyGroup,'Забрать сына в 18:00',memberRef);
    const accepted=(await tasks.execute(member,{action:'accept',id:task.id},randomUUID())).task!;

    const asked=await tasks.execute(familyMember,{action:'transfer',id:task.id,version:accepted.version,assigneeRef:ownerRef},randomUUID());
    // До согласия получателя ответственным остаётся прежний исполнитель.
    expect(asked.task).toMatchObject({assignee:'Member',pendingAssignee:'Owner',status:'accepted'});
    expect((await tasks.execute(familyMember,{action:'list',view:'mine'},'read')).tasks?.map(t=>t.id)).toContain(task.id);
    // Запрос ждёт именно получателя и виден в его списке.
    expect((await tasks.execute(familyGroup,{action:'list',view:'transfers'},'read')).tasks?.map(t=>t.id)).toEqual([task.id]);

    const taken=await tasks.execute(familyGroup,{action:'accept_transfer',id:task.id},randomUUID());
    expect(taken.task).toMatchObject({assignee:'Owner',pendingAssignee:null});
    // История дела теперь непрерывна: каждый переход оставил снимок прежнего состояния.
    const history=(await database().query(
      "SELECT action FROM shared_task_versions WHERE task_id=$1 ORDER BY version",[task.id])).rows;
    expect(history.map(row=>row.action)).toEqual(['accept','transfer','accept_transfer']);
  });

  it('refuses to hand a task to somebody who has left the family',async()=>{
    // Строка участника остаётся после выхода из семьи, поэтому дело можно было передать тому,
    // кто уже не сможет ни принять его, ни отказаться: оно повисало навсегда.
    const recipients=(await tasks.execute(familyGroup,{action:'participants'},'read')).participants!;
    const memberRef=recipients.find(p=>p.name==='Member')!.participantRef;
    const task=await make(familyGroup,'Забрать заказ');
    await database().query(
      "DELETE FROM family_memberships WHERE user_id=(SELECT id FROM users WHERE telegram_user_id='700102')");
    await expect(tasks.execute(familyGroup,{action:'transfer',id:task.id,
      version:task.version,assigneeRef:memberRef},randomUUID()))
      .rejects.toThrow(/AGENT_TASK_ACCESS_DENIED/);
  });

  it('closes a task that still has a transfer waiting for an answer',async()=>{
    // Схема запрещает висящий запрос передачи у незакрытого дела, поэтому закрытие обязано снять
    // его само: иначе «передал, ответа нет, сделал сам» кончалось бы непонятным сбоем базы.
    const recipients=(await tasks.execute(familyGroup,{action:'participants'},'read')).participants!;
    const ownerRef=recipients.find(p=>p.name==='Owner')!.participantRef;
    const task=await make(familyGroup,'Отвезти документы',recipients.find(p=>p.name==='Member')!.participantRef);
    const accepted=(await tasks.execute(member,{action:'accept',id:task.id},randomUUID())).task!;
    const asked=await tasks.execute(familyMember,{action:'transfer',id:task.id,
      version:accepted.version,assigneeRef:ownerRef},randomUUID());
    expect(asked.task).toMatchObject({pendingAssignee:'Owner'});

    const closed=await tasks.execute(familyMember,{action:'complete',id:task.id},randomUUID());
    expect(closed.task).toMatchObject({pendingAssignee:null,status:'completed'});
    expect((await tasks.execute(familyGroup,{action:'list',view:'transfers'},'read')).tasks).toEqual([]);
  });

  it('cancels a task that still has a transfer waiting for an answer',async()=>{
    const recipients=(await tasks.execute(familyGroup,{action:'participants'},'read')).participants!;
    const task=await make(familyGroup,'Записаться в сервис',recipients.find(p=>p.name==='Member')!.participantRef);
    const accepted=(await tasks.execute(member,{action:'accept',id:task.id},randomUUID())).task!;
    await tasks.execute(familyMember,{action:'transfer',id:task.id,version:accepted.version,
      assigneeRef:recipients.find(p=>p.name==='Owner')!.participantRef},randomUUID());
    const cancelled=await tasks.execute(familyGroup,{action:'cancel',id:task.id},randomUUID());
    expect(cancelled.task).toMatchObject({pendingAssignee:null,status:'cancelled'});
  });

  it('refuses to hand over a personal task instead of breaking on its own invariant',async()=>{
    // У личного дела хозяин всегда один и тот же человек: передавать и отпускать там некому.
    const personal=await make(owner,'Сходить к стоматологу');
    const recipients=(await tasks.execute(familyGroup,{action:'participants'},'read')).participants!;
    await expect(tasks.execute(owner,{action:'transfer',id:personal.id,version:personal.version,
      assigneeRef:recipients.find(p=>p.name==='Member')!.participantRef},randomUUID()))
      .rejects.toThrow(/AGENT_TASK_PERSONAL_HANDOVER/);
    await expect(tasks.execute(owner,{action:'release',id:personal.id,version:personal.version},randomUUID()))
      .rejects.toThrow(/AGENT_TASK_PERSONAL_HANDOVER/);
    const stored=await database().query(
      "SELECT status::text,assignee_telegram_id FROM shared_tasks WHERE id=$1",[personal.id]);
    expect(stored.rows[0]).toMatchObject({assignee_telegram_id:'700101',status:'accepted'});
  });

  it('makes a missing owner visible instead of assigning somebody else',async()=>{
    const recipients=(await tasks.execute(familyGroup,{action:'participants'},'read')).participants!;
    const task=await make(familyGroup,'Записать сына к врачу',recipients.find(p=>p.name==='Member')!.participantRef);
    const accepted=(await tasks.execute(member,{action:'accept',id:task.id},randomUUID())).task!;

    const released=await tasks.execute(familyMember,{action:'release',id:task.id,version:accepted.version},randomUUID());
    // Отказ исполнителя не назначает никого: дело становится свободным и видно всей области.
    expect(released.task).toMatchObject({assignee:null,status:'open'});
    expect((await tasks.execute(familyGroup,{action:'list',view:'open'},'read')).tasks?.map(t=>t.id)).toContain(task.id);
    // Чужое дело передать нельзя, даже автору.
    await expect(tasks.execute(familyGroup,{action:'transfer',id:task.id,version:released.task!.version,assigneeRef:recipients[0]!.participantRef},randomUUID()))
      .rejects.toThrow(/AGENT_TASK_TRANSITION_DENIED/);
  });

  it('closes one occurrence of a repeating task without closing the future ones',async()=>{
    await database().query(
      `INSERT INTO user_notification_settings(user_id,timezone,quiet_start,quiet_end)
       SELECT id,'UTC',NULL,NULL FROM users WHERE telegram_user_id='700101'`);
    const today=new Date().toISOString().slice(0,10);
    const created=await tasks.execute(owner,{action:'create',title:'Проверить расходники',
      dueOn:today,repeat:{interval:1,unit:'weekly'}},randomUUID());
    expect(created.task).toMatchObject({repeat:{interval:1,unit:'weekly'},status:'accepted'});

    const closed=await tasks.execute(owner,{action:'complete',id:created.task!.id},randomUUID());
    // Дело не уходит в completed: у него просто следующая дата.
    expect(closed.task).toMatchObject({status:'accepted'});
    expect(closed.task!.dueOn).not.toBe(today);
    expect(closed.task!.dueOn! > today).toBe(true);
    // Закрытое вхождение записано отдельной строкой: видно, кто и когда его закрыл.
    const occurrences=(await database().query(
      "SELECT actor_telegram_id,occurred_on::text FROM shared_ritual_occurrences WHERE task_id=$1",
      [created.task!.id])).rows;
    expect(occurrences).toEqual([{actor_telegram_id:'700101',occurred_on:today}]);

    // Второе «сделал» в тот же день ничего не закрывает: иначе завтрашнее вхождение исчезало бы
    // молча, не оставив следа ни в отметках, ни в сроке.
    const again=await tasks.execute(owner,{action:'complete',id:created.task!.id},randomUUID());
    expect(again.task!.dueOn).toBe(closed.task!.dueOn);
  });

  it('keeps the signal of a repeating task alive after one occurrence is closed',async()=>{
    await database().query(
      `INSERT INTO user_notification_settings(user_id,timezone,quiet_start,quiet_end)
       SELECT id,'UTC',NULL,NULL FROM users WHERE telegram_user_id='700101'
       ON CONFLICT (user_id) DO NOTHING`);
    const today=new Date().toISOString().slice(0,10);
    const created=(await tasks.execute(owner,{action:'create',title:'Полить цветы',
      dueOn:today,repeat:{interval:1,unit:'weekly'}},randomUUID())).task!;
    // Сигнал живёт своим расписанием, но привязан к делу: закрытие вхождения его не касается.
    await database().query(
      `INSERT INTO reminders(family_id,author_user_id,owner_user_id,scope,content,timezone,
         telegram_chat_id,recurrence_anchor_local,due_at,available_at,shared_task_id,
         recurrence_unit,recurrence_interval)
       SELECT m.family_id,u.id,u.id,'personal','Полить цветы','UTC','700101',
         now() AT TIME ZONE 'UTC',now()+interval '7 days',now()+interval '7 days',$1,'weekly',1
         FROM users u JOIN family_memberships m ON m.user_id=u.id
        WHERE u.telegram_user_id='700101'`,[created.id]);

    await tasks.execute(owner,{action:'complete',id:created.id},randomUUID());

    const signal=await database().query<{status:string}>(
      "SELECT status::text FROM reminders WHERE shared_task_id=$1",[created.id]);
    expect(signal.rows[0]).toMatchObject({status:'active'});
  });

  it('refuses a repeating task without a calendar date',async()=>{
    await expect(tasks.execute(owner,{action:'create',title:'Каждый день',
      repeat:{interval:1,unit:'daily'}},randomUUID())).rejects.toThrow(/AGENT_TASK_INPUT_INVALID/);
    await expect(tasks.execute(owner,{action:'create',title:'Каждый день',
      dueAt:new Date(Date.now()+86_400_000).toISOString(),
      repeat:{interval:1,unit:'daily'}},randomUUID())).rejects.toThrow(/AGENT_TASK_INPUT_INVALID/);
  });

  it('protects accepted work against edits by its proposer and concurrent stale revisions',async()=>{
    const recipients=(await tasks.execute(familyGroup,{action:'participants'},'read')).participants!;
    const task=await make(familyGroup,'Tickets',recipients.find(p=>p.name==='Member')!.participantRef);
    const accepted=(await tasks.execute(member,{action:'accept',id:task.id},'accept')).task!;
    const own=await make(familyGroup,'My task in the family');
    expect((await tasks.execute(familyGroup,{action:'list',view:'mine'},'read')).tasks?.map(t=>t.id)).toEqual([own.id]);
    expect((await tasks.execute(familyGroup,{action:'list',view:'waiting'},'read')).tasks?.map(t=>t.id)).toEqual([task.id]);
    await expect(tasks.execute(familyGroup,{action:'update',id:task.id,version:accepted.version,title:'Buy something else'},'rewrite')).rejects.toThrow();
    const changes=await Promise.allSettled([
      tasks.execute(member,{action:'update',id:task.id,version:accepted.version,dueOn:'2026-11-01'},'first'),
      tasks.execute(member,{action:'update',id:task.id,version:accepted.version,dueOn:'2026-12-01'},'second'),
    ]);
    expect(changes.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect((await tasks.execute(owner,{action:'list',view:'waiting'},'read')).tasks).toHaveLength(1);
    expect((await tasks.execute(owner,{action:'list'},'read')).tasks?.map(t=>t.id)).toEqual([own.id]);
  });
  it('asks Telegram about a group once per page, not once per task',async()=>{
    // Проверка членства ходит в сеть, пока транзакция держит блокировки строк, поэтому число
    // обращений должно зависеть от числа групп на странице, а не от числа найденных дел.
    currentMember.mockResolvedValue(true);
    await make(group,'First in the group');
    await make(group,'Second in the group');
    currentMember.mockClear();
    const result=await tasks.execute(owner,{action:'list'},'read');
    expect(result.tasks!.length).toBeGreaterThanOrEqual(2);
    expect(currentMember).toHaveBeenCalledTimes(1);
  });
  it('waits for every group of a page in one window instead of one after another',async()=>{
    // Десять групп по десять секунд подряд держали бы блокировки строк и соединение пула
    // до полутора минут на один список дел.
    currentMember.mockResolvedValue(true);
    await make(group,'Here');
    await make(secondGroup,'There');
    let started=0;
    let release!:()=>void;
    const gate=new Promise<void>((resolve)=>{release=resolve;});
    currentMember.mockImplementation(async()=>{started+=1;await gate;return true;});
    try {
      const listing=tasks.execute(owner,{action:'list'},'read');
      await vi.waitFor(()=>{ expect(started).toBe(2); },{timeout:5_000});
      release();
      expect((await listing).tasks!.length).toBeGreaterThanOrEqual(2);
    } finally {
      release();
      currentMember.mockImplementation(async()=>true);
    }
  });
  it('withdraws mutable group task access when Telegram membership is revoked',async()=>{
    const task=await make(group,'Group only');
    currentMember.mockResolvedValue(false);
    const result=await tasks.execute(owner,{action:'list'},'read');
    expect(result.tasks).toEqual([]); expect(result.incomplete).toBe(true);
    await expect(tasks.execute(owner,{action:'update',id:task.id,version:task.version,title:'Changed'},'change')).rejects.toThrow();
  });
  it('paginates large backlogs without duplicates',async()=>{
    await database().query(`INSERT INTO shared_tasks(family_id,scope,creator_telegram_id,assignee_telegram_id,title,status)
      SELECT $1,'personal',$2,$2,'Item '||n,'accepted' FROM generate_series(1,105) n`,[owner.familyId,owner.telegramUserId]);
    const first=await tasks.execute(owner,{action:'list'},'read');
    const second=await tasks.execute(owner,{action:'list',cursor:first.nextCursor!},'read');
    await expect(tasks.execute(owner,{action:'list',view:'ideas',cursor:first.nextCursor!},'bad-cursor')).rejects.toThrow(/AGENT_TASK_CURSOR_INVALID/);
    expect(first.tasks).toHaveLength(100); expect(second.tasks).toHaveLength(5);
    expect(new Set([...first.tasks!,...second.tasks!].map(t=>t.id)).size).toBe(105);
  });
  it('links reminders, preserves the task on delivery and stops future signals on completion',async()=>{
    const task=await make(owner,'Pick up parcel');
    const auth={familyId:owner.familyId,userId:owner.userId!,role:'owner' as const,telegramChatId:owner.telegramUserId!,telegramChatType:'private' as const,
      groupId:null,groupType:null,forumTopicId:null,messageThreadId:null};
    await reminderRepository.configureNotifications(auth,{timezone:'Europe/Moscow',quietStart:null,quietEnd:null});
    const due=new Date(Date.now()+60000);
    const reminder=await reminderRepository.create(auth,{taskId:task.id,content:task.title,firstRunAt:due,recurrence:{unit:'weekly',interval:1},scope:'personal',timezone:'Europe/Moscow',operationKey:'linked'});
    expect(reminder.taskId).toBe(task.id);
    expect((await tasks.execute(owner,{action:'list'},'read')).tasks![0]!.reminderCreated).toBe(true);
    const jobs=await reminderDispatchRepository.claimDue({now:new Date(due.getTime()+1000),limit:10,leaseMilliseconds:60000});
    expect(jobs).toHaveLength(1);
    await reminderDispatchRepository.markDispatchStarted(jobs[0]!.id,jobs[0]!.leaseToken);
    await reminderDispatchRepository.complete(jobs[0]!,new Date(due.getTime()+2000),{text:task.title,messageId:'9001'});
    expect((await tasks.execute(owner,{action:'list'},'read')).tasks![0]!.status).toBe('accepted');
    await tasks.execute(owner,{action:'complete',id:task.id},'done');
    expect((await reminderRepository.list(auth,{limit:20})).items[0]!.status).toBe('paused');
    await expect(reminderRepository.update(auth,reminder.id,{enabled:true,firstRunAt:new Date(Date.now()+120000),operationKey:'resume'})).rejects.toThrow(/AGENT_TASK_REMINDER_DENIED/);
    expect(await reminderDispatchRepository.claimDue({now:new Date(due.getTime()+1000),limit:10,leaseMilliseconds:60000})).toEqual([]);
  });

  it('rejects another persons reminder link and checks cancellation and membership before dispatch',async()=>{
    const auth={familyId:owner.familyId,userId:owner.userId!,role:'owner' as const,telegramChatId:owner.telegramUserId!,telegramChatType:'private' as const,
      groupId:null,groupType:null,forumTopicId:null,messageThreadId:null};
    await reminderRepository.configureNotifications(auth,{timezone:'Europe/Moscow',quietStart:null,quietEnd:null});
    const due=new Date(Date.now()+60000);
    const link=(task:{id:string;title:string},key:string)=>reminderRepository.create(auth,{taskId:task.id,content:task.title,firstRunAt:due,
      recurrence:{unit:'weekly' as const,interval:1},scope:'personal',timezone:'Europe/Moscow',operationKey:key});
    const somebodyElses=await make(member,'Their private task');
    await expect(link(somebodyElses,'wrong-person')).rejects.toThrow(/AGENT_TASK_REMINDER_DENIED/);
    const cancelled=await make(owner,'Cancel before dispatch');
    const revoked=await make(group,'Membership revoked before dispatch');
    const inFlight=await make(owner,'Already sending');
    const cancelledReminder=await link(cancelled,'cancelled');
    const revokedReminder=await link(revoked,'revoked');
    const inFlightReminder=await link(inFlight,'in-flight');
    const jobs=await reminderDispatchRepository.claimDue({now:new Date(due.getTime()+1000),limit:10,leaseMilliseconds:60000});
    expect(jobs).toHaveLength(3);
    const cancelledJob=jobs.find(j=>j.id===cancelledReminder.id)!;
    const revokedJob=jobs.find(j=>j.id===revokedReminder.id)!;
    const inFlightJob=jobs.find(j=>j.id===inFlightReminder.id)!;
    await tasks.execute(owner,{action:'cancel',id:cancelled.id},'cancel');
    await expect(reminderDispatchRepository.markDispatchStarted(cancelledJob.id,cancelledJob.leaseToken)).rejects.toThrow(/AGENT_TASK_REMINDER_DENIED/);
    currentMember.mockResolvedValue(false);
    await expect(reminderDispatchRepository.markDispatchStarted(revokedJob.id,revokedJob.leaseToken)).rejects.toThrow(/AGENT_TASK_REMINDER_DENIED/);
    await reminderDispatchRepository.markDispatchStarted(inFlightJob.id,inFlightJob.leaseToken);
    await tasks.execute(owner,{action:'complete',id:inFlight.id},'complete-in-flight');
    await reminderDispatchRepository.complete(inFlightJob,new Date(due.getTime()+2000),{text:inFlight.title,messageId:'9002'});
    expect((await reminderRepository.list(auth,{limit:20})).items.find(r=>r.id===inFlightJob.id)?.status).toBe('paused');
  });

});
