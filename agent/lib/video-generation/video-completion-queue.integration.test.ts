import {beforeEach,afterAll,describe,it,expect} from 'vitest';
import {database,closeDatabase} from '../database.js';
import {videoCompletionQueue} from './video-completion-queue.js';
const enabled=process.env.RUN_DATABASE_INTEGRATION_TESTS==='true';
if(enabled&&!new URL(process.env.DATABASE_URL!).pathname.endsWith('_test'))throw Error('Unsafe database');
const suite=enabled?describe:describe.skip;
const now=new Date('2026-09-13T12:00:00Z');
suite('durable completion of existing video orders',()=>{
  beforeEach(async()=>{
    await database().query('TRUNCATE video_generation_operations,video_budget_reservations,video_budget_accounts CASCADE');
    await database().query("INSERT INTO video_budget_accounts VALUES('998','2026-09')");
    await database().query("INSERT INTO video_budget_reservations(operation_key,actor_telegram_id,month,input_hash,reserved_micros) VALUES('job','998','2026-09',$1,500000)",['a'.repeat(64)]);
    await database().query(`INSERT INTO video_generation_operations(operation_key,workspace_id,target_key,model,output_path,
      completion_origin,delivery_state,completion_due_at) VALUES('job',gen_random_uuid(),'998:0',
      'bytedance/seedance-2.5','video.mp4','{"test":"verified-backend-context"}','pending',$1)`,[now]);
  });
  afterAll(closeDatabase);
  it('never claims an unconfirmed provider submission',async()=>{
    expect(await videoCompletionQueue.claim(now)).toEqual([]);
    await database().query("UPDATE video_generation_operations SET status='ambiguous',error_code='AGENT_VIDEO_STATUS_UNKNOWN' WHERE operation_key='job'");
    expect(await videoCompletionQueue.claim(now)).toEqual([]);
  });
  it('claims an accepted job once across competing dispatchers and recovers an expired lease',async()=>{
    await database().query("UPDATE video_generation_operations SET status='submitted',job_id='provider-job' WHERE operation_key='job'");
    const batches=await Promise.all([videoCompletionQueue.claim(now),videoCompletionQueue.claim(now)]);
    expect(batches.flat()).toHaveLength(1);
    const original=batches.flat()[0]!;
    await videoCompletionQueue.assertLease(original,now);
    await expect(videoCompletionQueue.assertLease(original,new Date(now.getTime()+180001))).rejects.toThrow('LEASE_STALE');
    const recovered=(await videoCompletionQueue.claim(new Date(now.getTime()+181000)))[0]!;
    expect(recovered.operationKey).toBe('job');expect(recovered.leaseToken).not.toBe(original.leaseToken);
    await expect(videoCompletionQueue.finish(original,'delivered',now)).rejects.toThrow('LEASE_STALE');
    await videoCompletionQueue.finish(recovered,'delivered',now);
    expect(await videoCompletionQueue.claim(new Date(now.getTime()+400000))).toEqual([]);
    expect((await database().query('SELECT count(*)::int n FROM video_budget_reservations')).rows[0].n).toBe(1);
  });
  it('defers a pending provider job without re-submitting or forgetting the lease identity',async()=>{
    await database().query("UPDATE video_generation_operations SET status='submitted',job_id='provider-job' WHERE operation_key='job'");
    const job=(await videoCompletionQueue.claim(now))[0]!;
    await videoCompletionQueue.defer(job,new Date(now.getTime()+60000),'AGENT_VIDEO_POLL_FAILED');
    expect(await videoCompletionQueue.claim(now)).toEqual([]);
    expect(await videoCompletionQueue.claim(new Date(now.getTime()+60001))).toHaveLength(1);
  });
  it('keeps original authorization immutable and does not adopt historical jobs without origin',async()=>{
    await expect(database().query("UPDATE video_generation_operations SET completion_origin='{}' WHERE operation_key='job'"))
      .rejects.toThrow('ORIGIN_IMMUTABLE');
    await database().query("DELETE FROM video_generation_operations WHERE operation_key='job'");
    await database().query("INSERT INTO video_generation_operations(operation_key,workspace_id,target_key,model,output_path,status,job_id) VALUES('job',gen_random_uuid(),'998:0','bytedance/seedance-2.5','old.mp4','submitted','old-provider-job')");
    expect(await videoCompletionQueue.claim(now)).toEqual([]);
  });
  it('uses the same lease for an interactive status check and the minute worker',async()=>{
    await database().query("UPDATE video_generation_operations SET status='submitted',job_id='provider-job' WHERE operation_key='job'");
    const [single,batch]=await Promise.all([videoCompletionQueue.claimOne('job',now),videoCompletionQueue.claim(now)]);
    expect((single?[single]:[]).concat(batch)).toHaveLength(1);
    expect(await videoCompletionQueue.claimOne('job',now)).toBeNull();
  });

});
