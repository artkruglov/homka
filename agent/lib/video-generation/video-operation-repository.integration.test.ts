import {afterAll,beforeEach,describe,expect,it} from 'vitest';
import {database,closeDatabase} from '../database.js';
import {videoOperationRepository as operations} from './video-operation-repository.js';
import {videoBudgetRepository as budget} from './video-budget-repository.js';
import {SEEDANCE_MODEL} from './video-pricing.js';
const enabled=process.env.RUN_DATABASE_INTEGRATION_TESTS==='true';
if(enabled&&!new URL(process.env.DATABASE_URL!).pathname.endsWith('_test'))throw Error('Unsafe test database');
const suite=enabled?describe:describe.skip;
const input={operationKey:'video-operation-1',workspaceId:'11111111-1111-4111-8111-111111111111',
  targetKey:'private:123',actorTelegramId:'123',inputHash:'a'.repeat(64),reservedMicros:2_000_000,
  outputPath:'/workspace/personal/video.mp4',model:SEEDANCE_MODEL} as const;
const file={path:input.outputPath,mediaType:'video/mp4',scope:'personal' as const,byteSize:1024,
  contentSha256:'b'.repeat(64),updatedAt:'2026-09-13T12:00:00.000Z'};
const get=()=>operations.get(input.operationKey,input.workspaceId,input.targetKey,input.actorTelegramId);
suite('durable video operations',()=>{
  it('lists recent jobs only for the same person, workspace and chat/topic',async()=>{
    await operations.begin(input);
    await operations.begin({...input,operationKey:'other-chat',targetKey:'group:456'});
    await operations.begin({...input,operationKey:'other-person',actorTelegramId:'456'});
    await operations.begin({...input,operationKey:'other-workspace',workspaceId:'22222222-2222-4222-8222-222222222222'});
    const rows=await operations.list(input.workspaceId,input.targetKey,input.actorTelegramId);
    expect(rows.map(row=>row.operationKey)).toEqual([input.operationKey]);
    expect(await operations.list(input.workspaceId,input.targetKey,'789')).toEqual([]);
  });
  beforeEach(async()=>{await database().query('TRUNCATE video_generation_operations,video_budget_reservations,video_budget_accounts');});
  afterAll(closeDatabase);
  it('rolls back the budget if the durable start marker cannot be written',async()=>{
    await expect(operations.begin({...input,workspaceId:'invalid'})).rejects.toThrow();
    expect((await budget.balance('123')).usedMicros).toBe(0);
    expect(await operations.begin(input)).toMatchObject({execute:true,operation:{status:'started'}});
  });
  it('allows exactly one submit owner across concurrent calls and scopes replay',async()=>{
    const results=await Promise.all([operations.begin(input),operations.begin(input)]);
    expect(results.filter(result=>result.execute)).toHaveLength(1);
    expect((await budget.balance('123')).usedMicros).toBe(2_000_000);
    await expect(operations.begin({...input,targetKey:'group:other'})).rejects.toMatchObject({code:'AGENT_VIDEO_REPLAY_MISMATCH'});
    expect(await operations.get(input.operationKey,input.workspaceId,input.targetKey,'456')).toBeNull();
    expect(await operations.get(input.operationKey,input.workspaceId,'group:other','123')).toBeNull();
  });
  it('keeps ambiguous submission terminal and its cost reserved',async()=>{
    await operations.begin(input);
    await operations.fail(input.operationKey,'ambiguous','AGENT_VIDEO_SUBMIT_AMBIGUOUS');
    expect(await operations.begin(input)).toMatchObject({execute:false,operation:{status:'ambiguous'}});
    await expect(operations.submitted(input.operationKey,'job-1')).rejects.toMatchObject({code:'AGENT_VIDEO_STATE_INVALID'});
    expect((await budget.balance('123')).usedMicros).toBe(2_000_000);
  });
  it('retains the confirmed job for polling and rejects conflicting job or result replays',async()=>{
    await operations.begin(input);
    await expect(operations.complete(input.operationKey,file)).rejects.toThrow();
    await operations.submitted(input.operationKey,'job-1');
    await operations.submitted(input.operationKey,'job-1');
    await expect(operations.submitted(input.operationKey,'job-2')).rejects.toThrow();
    await expect(operations.complete(input.operationKey,{...file,path:'/workspace/family/other.mp4'})).rejects.toThrow();
    await operations.complete(input.operationKey,file);
    await operations.complete(input.operationKey,file);
    await expect(operations.complete(input.operationKey,{...file,contentSha256:'c'.repeat(64)})).rejects.toThrow();
    await expect(operations.fail(input.operationKey,'failed','AGENT_VIDEO_FAILED')).rejects.toThrow();
    expect(await get()).toMatchObject({status:'completed',jobId:'job-1',file});
  });
});
