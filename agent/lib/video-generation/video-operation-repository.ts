/** Durable job marker and the monthly budget are reserved in one transaction before submit. */
import {parseVideoCompletionOrigin,videoOriginTargetKey,type VideoCompletionOrigin} from './video-completion-origin.js';
import {isDeepStrictEqual} from 'node:util';
import {database} from '../database.js';
import {AppError} from '../app-error.js';
import type {WorkspaceFileRecord} from '../workspaces/workspace-file-record.js';
import {videoBudgetRepository} from './video-budget-repository.js';
import {SEEDANCE_MODEL} from './video-pricing.js';

export interface VideoOperation {
  operationKey:string;workspaceId:string;targetKey:string;model:string;outputPath:string;
  status:'started'|'submitted'|'completed'|'ambiguous'|'failed';
  deliveryState?:'pending'|'delivered'|'cancelled'|'failed'|null;completionErrorCode?:string|null;
  completionOrigin?:unknown;jobId:string|null;file:WorkspaceFileRecord|null;errorCode:string|null;
}
const projection=`o.operation_key AS "operationKey",o.workspace_id AS "workspaceId",o.target_key AS "targetKey",
  o.completion_origin AS "completionOrigin",o.delivery_state AS "deliveryState",o.completion_error_code AS "completionErrorCode",o.model,o.output_path AS "outputPath",o.status,o.job_id AS "jobId",o.result AS file,o.error_code AS "errorCode"`;
function invalid(){return new AppError('AGENT_VIDEO_STATE_INVALID','Состояние видеозадания изменилось. Прочитайте его ещё раз');}

export const videoOperationRepository={
  async cancelDelivery(operationKey:string,workspaceId:string,targetKey:string,actorTelegramId:string){
    const current=await this.get(operationKey,workspaceId,targetKey,actorTelegramId);
    if(!current)throw new AppError('AGENT_VIDEO_NOT_FOUND','Видеозадание не найдено в вашем текущем чате');
    if(!current.completionOrigin)throw new AppError('AGENT_VIDEO_COMPLETION_ORIGIN_INVALID','У этого прежнего заказа нет автоматической доставки');
    await database().query(`UPDATE video_generation_operations o SET delivery_state='cancelled',
      completion_error_code='AGENT_VIDEO_DELIVERY_CANCELLED',completion_lease_token=NULL,completion_lease_until=NULL
      FROM video_budget_reservations b WHERE o.operation_key=b.operation_key AND o.operation_key=$1
        AND o.workspace_id=$2 AND o.target_key=$3 AND b.actor_telegram_id=$4 AND o.delivery_state='pending'`,
      [operationKey,workspaceId,targetKey,actorTelegramId]);
    const result=await this.get(operationKey,workspaceId,targetKey,actorTelegramId);
    if(!result)throw new AppError('AGENT_VIDEO_NOT_FOUND','Видеозадание больше недоступно');
    return {cancelled:result.deliveryState==='cancelled',deliveryState:result.deliveryState};
  },
  async list(workspaceId:string,targetKey:string,actorTelegramId:string):Promise<VideoOperation[]>{
    return (await database().query<VideoOperation>(`SELECT ${projection} FROM video_generation_operations o
      JOIN video_budget_reservations b USING(operation_key)
      WHERE o.workspace_id=$1 AND o.target_key=$2 AND b.actor_telegram_id=$3
      ORDER BY o.created_at DESC,o.operation_key DESC LIMIT 20`,[workspaceId,targetKey,actorTelegramId])).rows;
  },
  async get(operationKey:string,workspaceId:string,targetKey:string,actorTelegramId:string):Promise<VideoOperation|null>{
    return (await database().query<VideoOperation>(`SELECT ${projection} FROM video_generation_operations o
      JOIN video_budget_reservations b USING(operation_key)
      WHERE o.operation_key=$1 AND o.workspace_id=$2 AND o.target_key=$3 AND b.actor_telegram_id=$4`,
      [operationKey,workspaceId,targetKey,actorTelegramId])).rows[0]??null;
  },
  async begin(input:{operationKey:string;workspaceId:string;targetKey:string;actorTelegramId:string;
    inputHash:string;reservedMicros:number;outputPath:string;model:typeof SEEDANCE_MODEL;completionOrigin?:VideoCompletionOrigin}){
    const origin=input.completionOrigin===undefined?null:parseVideoCompletionOrigin(input.completionOrigin);
    if(origin&&(origin.workspaceId!==input.workspaceId||origin.actorTelegramId!==input.actorTelegramId||
      videoOriginTargetKey(origin)!==input.targetKey))throw invalid();
    const hold=await videoBudgetRepository.reserve(input,async client=>{
      await client.query(`INSERT INTO video_generation_operations(operation_key,workspace_id,target_key,model,output_path,space_id,
        completion_origin,delivery_state,completion_due_at)
        VALUES($1,$2,$3,$4,$5,(SELECT space_id FROM workspaces WHERE id=$2),$6,
          CASE WHEN $6::jsonb IS NULL THEN NULL ELSE 'pending' END,
          CASE WHEN $6::jsonb IS NULL THEN NULL ELSE now()+interval '30 seconds' END)`,
        [input.operationKey,input.workspaceId,input.targetKey,input.model,input.outputPath,origin===null?null:JSON.stringify(origin)]);
    });
    const operation=await this.get(input.operationKey,input.workspaceId,input.targetKey,input.actorTelegramId);
    if(!operation||operation.model!==input.model||operation.outputPath!==input.outputPath||
      !isDeepStrictEqual(operation.completionOrigin??null,origin)) {
      throw new AppError('AGENT_VIDEO_REPLAY_MISMATCH','Видеозадание не совпадает с исходным запросом и чатом');
    }
    return {execute:hold.execute,operation};
  },
  async submitted(operationKey:string,jobId:string){
    if(!/^[A-Za-z0-9_-]{1,200}$/u.test(jobId))throw invalid();
    const changed=await database().query(`UPDATE video_generation_operations SET
      status=CASE WHEN status='started' THEN 'submitted' ELSE status END,job_id=$2,updated_at=now()
      WHERE operation_key=$1 AND ((status='started' AND job_id IS NULL) OR
        (status IN ('submitted','completed') AND job_id=$2))`,[operationKey,jobId]);
    if(!changed.rowCount)throw invalid();
  },
  async complete(operationKey:string,file:WorkspaceFileRecord){
    if(file.mediaType!=='video/mp4')throw invalid();
    const changed=await database().query(`UPDATE video_generation_operations SET status='completed',result=$2,updated_at=now()
      WHERE operation_key=$1 AND output_path=$3 AND
        (status='submitted' OR (status='completed' AND result=$2::jsonb))`,[operationKey,JSON.stringify(file),file.path]);
    if(!changed.rowCount)throw invalid();
  },
  async fail(operationKey:string,state:'failed'|'ambiguous',errorCode:string){
    if(!/^AGENT_[A-Z0-9_]+$/u.test(errorCode))throw invalid();
    const changed=await database().query(`UPDATE video_generation_operations SET status=$2,error_code=$3,updated_at=now()
      WHERE operation_key=$1 AND (status='started' OR (status='submitted' AND $2='failed') OR
        (status=$2 AND error_code=$3))`,[operationKey,state,errorCode]);
    if(!changed.rowCount)throw invalid();
  },
};
