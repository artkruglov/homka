/** Application queue for polling/delivering accepted jobs. It has no provider submit path.
 * Origin is private backend data; it must be decoded and live-authorized by the completion
 * adapter before any read or delivery. This repository itself grants no access to workspace.
 */
import {database} from '../database.js';
import {AppError} from '../app-error.js';
export interface ClaimedVideoCompletion {
  operationKey:string;leaseToken:string;origin:unknown;
}
function stale(){return new AppError('AGENT_VIDEO_COMPLETION_LEASE_STALE','Обработка видео уже передана другому проходу');}
export const videoCompletionQueue={
  async claimOne(operationKey:string,now=new Date()):Promise<ClaimedVideoCompletion|null>{
    return (await database().query<ClaimedVideoCompletion>(`UPDATE video_generation_operations
      SET completion_lease_token=gen_random_uuid(),completion_lease_until=$2::timestamptz+interval '180 seconds'
      WHERE operation_key=$1 AND delivery_state='pending' AND completion_origin IS NOT NULL
        AND status IN ('submitted','completed') AND job_id IS NOT NULL
        AND (completion_lease_until IS NULL OR completion_lease_until<=$2)
      RETURNING operation_key AS "operationKey",completion_lease_token AS "leaseToken",completion_origin AS origin`,
      [operationKey,now])).rows[0]??null;
  },
  async claim(now:Date):Promise<ClaimedVideoCompletion[]>{
    return (await database().query<ClaimedVideoCompletion>(`WITH due AS (
      SELECT operation_key FROM video_generation_operations
      WHERE delivery_state='pending' AND completion_origin IS NOT NULL
        AND status IN ('submitted','completed') AND job_id IS NOT NULL
        AND completion_due_at<=$1 AND (completion_lease_until IS NULL OR completion_lease_until<=$1)
      ORDER BY completion_due_at,operation_key LIMIT 4 FOR UPDATE SKIP LOCKED
    ) UPDATE video_generation_operations o SET completion_lease_token=gen_random_uuid(),
      completion_lease_until=$1::timestamptz+interval '180 seconds'
      FROM due WHERE o.operation_key=due.operation_key
      RETURNING o.operation_key AS "operationKey",o.completion_lease_token AS "leaseToken",
        o.completion_origin AS origin`,[now])).rows;
  },
  async assertLease(job:ClaimedVideoCompletion,now=new Date()):Promise<void>{
    const current=await database().query(`SELECT 1 FROM video_generation_operations
      WHERE operation_key=$1 AND completion_lease_token=$2 AND completion_lease_until>$3
        AND delivery_state='pending' AND status IN ('submitted','completed')`,
      [job.operationKey,job.leaseToken,now]);
    if(current.rowCount!==1)throw stale();
  },
  async defer(job:ClaimedVideoCompletion,dueAt:Date,errorCode:string|null){
    const result=await database().query(`UPDATE video_generation_operations SET completion_due_at=$3,
      completion_error_code=$4,completion_lease_token=NULL,completion_lease_until=NULL
      WHERE operation_key=$1 AND completion_lease_token=$2 AND delivery_state='pending'`,
      [job.operationKey,job.leaseToken,dueAt,errorCode]);
    if(result.rowCount!==1)throw stale();
  },
  async finish(job:ClaimedVideoCompletion,state:'delivered'|'cancelled'|'failed',now:Date,errorCode:string|null=null){
    const result=await database().query(`UPDATE video_generation_operations SET delivery_state=$3,
      completion_due_at=$4,completion_error_code=$5,completion_lease_token=NULL,completion_lease_until=NULL
      WHERE operation_key=$1 AND completion_lease_token=$2 AND delivery_state='pending'`,
      [job.operationKey,job.leaseToken,state,now,errorCode]);
    if(result.rowCount!==1)throw stale();
  },
};
