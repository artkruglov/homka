import {afterAll,beforeEach,describe,expect,it} from 'vitest';
import {database,closeDatabase} from '../database.js';
import {videoBudgetRepository as budget} from './video-budget-repository.js';
const enabled=process.env.RUN_DATABASE_INTEGRATION_TESTS==='true';
if(enabled&&!new URL(process.env.DATABASE_URL!).pathname.endsWith('_test'))throw Error('Unsafe test database');
const suite=enabled?describe:describe.skip;
const input={actorTelegramId:'123',operationKey:'video-budget-1',inputHash:'a'.repeat(64),reservedMicros:20_000_000};
suite('monthly video budget',()=>{
  beforeEach(async()=>{await database().query('TRUNCATE video_budget_reservations,video_budget_accounts CASCADE');});
  afterAll(closeDatabase);
  it('serializes concurrent requests across chats for one person',async()=>{
    const results=await Promise.allSettled([budget.reserve(input),budget.reserve({...input,operationKey:'another-chat'})]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{code:'AGENT_VIDEO_BUDGET_EXCEEDED'}});
    expect((await budget.balance('123')).usedMicros).toBe(20_000_000);
  });
  it('reserves one call once and refuses identity or prompt drift',async()=>{
    const results=await Promise.all([budget.reserve(input),budget.reserve(input)]);
    expect(results.filter(r=>r.execute)).toHaveLength(1);
    await expect(budget.reserve({...input,inputHash:'b'.repeat(64)})).rejects.toMatchObject({code:'AGENT_VIDEO_REPLAY_MISMATCH'});
    await expect(budget.reserve({...input,actorTelegramId:'456'})).rejects.toMatchObject({code:'AGENT_VIDEO_REPLAY_MISMATCH'});
    expect((await budget.balance('456')).usedMicros).toBe(0);
  });
  it('settles once from confirmed cost and retains unknown charges by default',async()=>{
    await budget.reserve(input);
    expect((await budget.balance('123')).usedMicros).toBe(20_000_000);
    await budget.settle(input.operationKey,2_000_000);
    await budget.settle(input.operationKey,2_000_000);
    expect((await budget.balance('123')).usedMicros).toBe(2_000_000);
    await expect(budget.settle(input.operationKey,0)).rejects.toMatchObject({code:'AGENT_VIDEO_COST_CONFLICT'});
  });
  it('does not share limits between people and fails closed on invalid reservations',async()=>{
    await budget.reserve(input);
    await budget.reserve({...input,operationKey:'other-person',actorTelegramId:'456'});
    for(const value of [0,-1,NaN,30_000_001]) await expect(budget.reserve({...input,reservedMicros:value})).rejects.toThrow();
    expect((await budget.balance('123')).usedMicros).toBe(20_000_000);
  });
  it('retains the original month on a replay and counts only current-month requests in balance',async()=>{
    await database().query("INSERT INTO video_budget_accounts VALUES('123','2020-01')");
    await database().query(`INSERT INTO video_budget_reservations(operation_key,actor_telegram_id,month,input_hash,reserved_micros)
      VALUES($1,'123','2020-01',$2,20000000)`,[input.operationKey,input.inputHash]);
    expect(await budget.reserve(input)).toMatchObject({execute:false,month:'2020-01'});
    expect((await budget.balance('123')).usedMicros).toBe(0);
    await budget.settle(input.operationKey,10_000_000);
    await budget.reserve({...input,operationKey:'new-month'});
    expect((await budget.balance('123')).usedMicros).toBe(20_000_000);
  });
});
