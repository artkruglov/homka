/** Bounded application completion worker. Only resume exists here; submitting is impossible.
 * A live-authorized adapter must revalidate the lease and exact saved origin before effects.
 */
import {AppError,isAppError} from '../app-error.js';
import type {ClaimedVideoCompletion,videoCompletionQueue} from './video-completion-queue.js';
interface Dependencies {
  queue:Pick<typeof videoCompletionQueue,'claim'|'defer'|'finish'>;
  resume(job:ClaimedVideoCompletion):Promise<{status:'pending'|'completed';delivery?:unknown}>;
}
const retryable=new Set(['AGENT_VIDEO_MIGRATION_AUDIENCE_PENDING','AGENT_VIDEO_POLL_FAILED','AGENT_VIDEO_DOWNLOAD_FAILED']);
const revoked=new Set(['AGENT_VIDEO_ACCESS_CHANGED','AGENT_WORKSPACE_ACCESS_REVOKED',
  'AGENT_WORKSPACE_ACCESS_DENIED','AGENT_VIDEO_COMPLETION_ACCESS_REVOKED']);
export function createVideoCompletionDispatcher(deps:Dependencies){
  return async function dispatch(now=new Date()):Promise<number>{
    const jobs=await deps.queue.claim(now);
    const outcomes=await Promise.allSettled(jobs.map(async job=>{
      try{
        const result=await deps.resume(job);
        if(result.status==='pending'){
          await deps.queue.defer(job,new Date(now.getTime()+60000),null);return;
        }
        if(!result.delivery||typeof result.delivery!=='object'||
          !('delivered' in result.delivery)||result.delivery.delivered!==true){
          throw new AppError('AGENT_VIDEO_COMPLETION_DELIVERY_UNCONFIRMED','Доставка видео не подтверждена');
        }
        await deps.queue.finish(job,'delivered',now);
      }catch(error){
        const code=isAppError(error)?error.code:'AGENT_VIDEO_COMPLETION_RETRY';
        if(code==='AGENT_VIDEO_COMPLETION_LEASE_STALE')return;
        if(!isAppError(error)||retryable.has(code)){
          await deps.queue.defer(job,new Date(now.getTime()+60000),code);
        }else{
          // An ambiguous Telegram result is terminal. Its durable sender receipt is retained;
          // automatic completion must never manufacture another delivery key to retry it.
          await deps.queue.finish(job,revoked.has(code)?'cancelled':'failed',now,code);
        }
      }
    }));
    const failed=outcomes.filter((r):r is PromiseRejectedResult=>r.status==='rejected');
    if(failed.length)throw new AggregateError(failed.map(r=>r.reason),'Video completion persistence failed');
    return jobs.length;
  };
}
