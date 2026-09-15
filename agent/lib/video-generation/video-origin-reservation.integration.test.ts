import {afterAll,beforeEach,describe,it,expect} from 'vitest';
import {database,closeDatabase} from '../database.js';
import {videoOperationRepository} from './video-operation-repository.js';
import {parseVideoCompletionOrigin} from './video-completion-origin.js';
import {videoCompletionQueue} from './video-completion-queue.js';
import {SEEDANCE_MODEL} from './video-pricing.js';
const enabled=process.env.RUN_DATABASE_INTEGRATION_TESTS==='true';
if(enabled&&!new URL(process.env.DATABASE_URL!).pathname.endsWith('_test'))throw Error('Unsafe database');
const id='12345678-1234-4234-8234-123456789abc';
const origin=parseVideoCompletionOrigin({version:1,workspaceId:id,actorTelegramId:'998',scope:'personal',target:{chatId:'998'},
  authorization:{familyId:id,userId:id,role:'owner',groupId:null,groupType:null,telegramChatType:'private'}});
const input={workspaceId:id,actorTelegramId:'998',targetKey:'998:0',operationKey:'origin-order',inputHash:'a'.repeat(64),
  reservedMicros:500000,outputPath:'video.mp4',model:SEEDANCE_MODEL,completionOrigin:origin} satisfies Parameters<typeof videoOperationRepository.begin>[0];
(enabled?describe:describe.skip)('origin and budget reservation transaction',()=>{
  beforeEach(async()=>{await database().query('TRUNCATE video_generation_operations,video_budget_reservations,video_budget_accounts CASCADE');});
  afterAll(closeDatabase);
  it('stores the exact origin atomically with the hold and retains it on replay',async()=>{
    expect((await videoOperationRepository.begin(input)).execute).toBe(true);
    expect((await videoOperationRepository.begin(input)).execute).toBe(false);
    const row=(await database().query('SELECT completion_origin,delivery_state,completion_due_at FROM video_generation_operations')).rows[0];
    expect(row.completion_origin).toEqual(origin);expect(row.delivery_state).toBe('pending');expect(row.completion_due_at).toBeTruthy();
    expect((await database().query('SELECT count(*)::int n FROM video_budget_reservations')).rows[0].n).toBe(1);
    await expect(videoOperationRepository.begin({...input,completionOrigin:undefined})).rejects.toMatchObject({code:'AGENT_VIDEO_REPLAY_MISMATCH'});
    await expect(videoOperationRepository.begin({...input,completionOrigin:{...origin,authorization:{...origin.authorization,role:'member'}}}))
      .rejects.toMatchObject({code:'AGENT_VIDEO_REPLAY_MISMATCH'});
  });
  it('refuses substituted actor or target before reserving money',async()=>{
    await expect(videoOperationRepository.begin({...input,targetKey:'999:0'})).rejects.toThrow('Состояние');
    expect((await database().query('SELECT count(*)::int n FROM video_budget_reservations')).rows[0].n).toBe(0);
  });
  it('does not leave a paid hold if persisting the origin fails',async()=>{
    await database().query("CREATE FUNCTION fail_video_origin_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'origin write failed'; END $$; CREATE TRIGGER fail_video_origin_test BEFORE INSERT ON video_generation_operations FOR EACH ROW EXECUTE FUNCTION fail_video_origin_test()");
    try{await expect(videoOperationRepository.begin(input)).rejects.toThrow('origin write failed');}
    finally{await database().query('DROP TRIGGER fail_video_origin_test ON video_generation_operations; DROP FUNCTION fail_video_origin_test()');}
    expect((await database().query('SELECT count(*)::int n FROM video_budget_reservations')).rows[0].n).toBe(0);
  });
  it('cancels only its own pending delivery, invalidates the worker lease and keeps the paid hold',async()=>{
    await videoOperationRepository.begin(input);
    await videoOperationRepository.submitted(input.operationKey,'provider-job');
    const lease=await videoCompletionQueue.claimOne(input.operationKey);expect(lease).toBeTruthy();
    await expect(videoOperationRepository.cancelDelivery(input.operationKey,id,input.targetKey,'999')).rejects.toThrow('NOT_FOUND');
    expect(await videoOperationRepository.cancelDelivery(input.operationKey,id,input.targetKey,'998')).toEqual({cancelled:true,deliveryState:'cancelled'});
    await expect(videoCompletionQueue.assertLease(lease!)).rejects.toThrow('LEASE_STALE');
    expect(await videoCompletionQueue.claimOne(input.operationKey)).toBeNull();
    expect((await database().query('SELECT reserved_micros FROM video_budget_reservations')).rows[0].reserved_micros).toBe('500000');
  });

});
