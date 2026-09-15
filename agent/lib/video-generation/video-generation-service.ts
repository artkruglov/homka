/** Application orchestration; adapters must derive access from verified context and live storage. */
import type {VideoCompletionOrigin} from './video-completion-origin.js';
import {createHash} from 'node:crypto';
import {AppError,isAppError} from '../app-error.js';
import type {WorkspaceFileRecord,WorkspaceScope} from '../workspaces/workspace-file-record.js';
import type {videoOperationRepository} from './video-operation-repository.js';
import type {VideoRequest} from './openrouter-video-client.js';
import {SEEDANCE_MODEL} from './video-pricing.js';

export interface VideoAccess {
  workspaceId:string;targetKey:string;actorTelegramId:string;scope:WorkspaceScope;
  completionOrigin?:VideoCompletionOrigin;
}
export type VideoResumeResult={status:'pending';operationKey:string}|
  {status:'completed';operationKey:string;path:string;delivery:unknown};
interface Dependencies {
  resumeAccepted?:(operationKey:string)=>Promise<VideoResumeResult>;
  authorize():Promise<VideoAccess>;
  operations:Pick<typeof videoOperationRepository,'get'|'begin'|'submitted'|'complete'|'fail'>;
  budget:{settle(operationKey:string,actualMicros:number):Promise<unknown>};
  client:{
    assertConfigured():void;
    quote(input:VideoRequest):Promise<{reservedMicros:number}>;
    submit(input:VideoRequest):Promise<{jobId:string}>;
    inspectStatus(jobId:string):Promise<{status:'pending'|'completed'|'failed';actualCostMicros?:number}>;
    download(jobId:string):Promise<Buffer>;
  };
  files:{
    find(access:VideoAccess,operationKey:string):Promise<WorkspaceFileRecord|null>;
    write(access:VideoAccess,input:{operationKey:string;path:string;bytes:Buffer}):Promise<WorkspaceFileRecord>;
    // Must wrap existing durable sender using this stable identity across different tool calls.
    deliver(access:VideoAccess,file:WorkspaceFileRecord,deliveryKey:string):Promise<unknown>;
  };
}
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const unknown=()=>new AppError('AGENT_VIDEO_STATUS_UNKNOWN','Исход отправки видеозадания не подтверждён. Новая генерация автоматически не запускается');
function sameAccess(a:VideoAccess,b:VideoAccess){
  if(a.workspaceId!==b.workspaceId||a.targetKey!==b.targetKey||a.actorTelegramId!==b.actorTelegramId||a.scope!==b.scope){
    throw new AppError('AGENT_VIDEO_ACCESS_CHANGED','Доступ к исходному чату видеозадания изменился');
  }
}

type ResumptionDependencies=Omit<Dependencies,'operations'|'client'>&{
  operations:Pick<Dependencies['operations'],'get'|'complete'|'fail'>;
  client:Pick<Dependencies['client'],'inspectStatus'|'download'>;
};
/** Completion has no pricing, reservation or paid submit dependency. */
export function createVideoResumptionService(deps:ResumptionDependencies){
  const reauthorize=async(access:VideoAccess)=>{sameAccess(access,await deps.authorize());};
  const resume=async(operationKey:string)=>{
    const access=await deps.authorize();
    const operation=await deps.operations.get(operationKey,access.workspaceId,access.targetKey,access.actorTelegramId);
    if(!operation)throw new AppError('AGENT_VIDEO_NOT_FOUND','Видеозадание не найдено в вашем текущем чате');
    if(operation.status==='started'||operation.status==='ambiguous')throw unknown();
    if(operation.status==='failed')throw new AppError(operation.errorCode??'AGENT_VIDEO_FAILED','Видеозадание завершилось ошибкой');
    let file=operation.file;
    if(operation.status==='submitted'){
      if(!operation.jobId)throw unknown();
      const status=await deps.client.inspectStatus(operation.jobId);
      if(status.status==='pending')return {status:'pending' as const,operationKey};
      // Provisional costs (often zero) during processing must not free a live reservation.
      if(status.actualCostMicros!==undefined)await deps.budget.settle(operationKey,status.actualCostMicros);
      if(status.status==='failed'){
        await deps.operations.fail(operationKey,'failed','AGENT_VIDEO_FAILED');
        throw new AppError('AGENT_VIDEO_FAILED','Провайдер не завершил создание видео');
      }
      await reauthorize(access);
      file=await deps.files.find(access,operationKey);
      if(!file){
        const bytes=await deps.client.download(operation.jobId);
        await reauthorize(access);
        file=await deps.files.write(access,{operationKey,path:operation.outputPath,bytes});
      }
      if(file.path!==operation.outputPath||file.scope!==access.scope||file.mediaType!=='video/mp4')throw unknown();
      await deps.operations.complete(operationKey,file);
    }
    if(!file||file.path!==operation.outputPath||file.scope!==access.scope||file.mediaType!=='video/mp4')throw unknown();
    await reauthorize(access);
    const delivery=await deps.files.deliver(access,file,`video-delivery:${operationKey}`);
    return {status:'completed' as const,operationKey,path:file.path,delivery};
  };
  return resume;
}

export function createVideoGenerationService(deps:Dependencies){
  const resume=deps.resumeAccepted??createVideoResumptionService(deps);
  const reauthorize=async(access:VideoAccess)=>{sameAccess(access,await deps.authorize());};
  return {
    resume,
    async start(input:{operationKey:string;prompt:string;duration:number;size:string;firstFrame?:VideoRequest['firstFrame']}){
      const access=await deps.authorize();
      deps.client.assertConfigured();
      const request:VideoRequest={model:SEEDANCE_MODEL,prompt:input.prompt,duration:input.duration,
        size:input.size,resolution:'720p',aspectRatio:'16:9',...(input.firstFrame?{firstFrame:input.firstFrame}:{})};
      const quote=await deps.client.quote(request);
      const inputHash=digest(JSON.stringify({prompt:input.prompt,duration:input.duration,size:input.size,access,
        firstFrame:input.firstFrame?{hash:digest(input.firstFrame.bytes.toString('base64')),mediaType:input.firstFrame.mediaType}:null}));
      await reauthorize(access);
      const reservation=await deps.operations.begin({...access,operationKey:input.operationKey,inputHash,
        reservedMicros:quote.reservedMicros,model:SEEDANCE_MODEL,
        outputPath:`generated-videos/video-${digest(input.operationKey).slice(0,24)}.mp4`});
      if(reservation.execute){
        let job;
        try {
          await reauthorize(access);
        }catch(error){
          await deps.operations.fail(input.operationKey,'failed',
            isAppError(error)&&error.code==='AGENT_VIDEO_TURN_CANCELLED'?error.code:'AGENT_VIDEO_ACCESS_CHANGED');
          await deps.budget.settle(input.operationKey,0);
          throw error;
        }
        try {job=await deps.client.submit(request);}
        catch(error){
          const rejected=isAppError(error)&&error.code==='AGENT_VIDEO_REJECTED';
          await deps.operations.fail(input.operationKey,rejected?'failed':'ambiguous',
            rejected?'AGENT_VIDEO_REJECTED':'AGENT_VIDEO_STATUS_UNKNOWN');
          if(rejected)await deps.budget.settle(input.operationKey,0);
          if(rejected)throw error;
          throw unknown();
        }
        // If this write fails, keep the started marker; never submit again on a replay.
        try {await deps.operations.submitted(input.operationKey,job.jobId);}
        catch {throw unknown();}
      }
      return resume(input.operationKey);
    },
  };
}
