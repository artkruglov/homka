/** One queue lease coordinates human status requests and the minute worker. */
import {AppError} from '../app-error.js';
import {videoCompletionQueue} from './video-completion-queue.js';
import {createVideoCompletionDispatcher} from './video-completion-dispatcher.js';
import {resumeQueuedVideo} from './video-completion-runtime.js';
import {videoOperationRepository} from './video-operation-repository.js';
import type {VideoAccess,VideoResumeResult} from './video-generation-service.js';

export async function dispatchQueuedVideos(){
  return createVideoCompletionDispatcher({queue:videoCompletionQueue,resume:resumeQueuedVideo})();
}
export async function resumeCoordinatedVideo(operationKey:string,access:VideoAccess):Promise<VideoResumeResult>{
  // Recheck the request's owner/scope before acquiring a lease; job ids supplied by a model
  // cannot cause work in another person's chat, even though the worker has backend access.
  const read=()=>videoOperationRepository.get(operationKey,access.workspaceId,access.targetKey,access.actorTelegramId);
  const initial=await read();
  if(!initial)throw new AppError('AGENT_VIDEO_NOT_FOUND','Видеозадание не найдено в вашем текущем чате');
  if(!initial.completionOrigin)throw new AppError('AGENT_VIDEO_COMPLETION_ORIGIN_INVALID','Исходный контекст видеозадания не подтверждён');
  if(initial.status==='started'||initial.status==='ambiguous')throw new AppError('AGENT_VIDEO_STATUS_UNKNOWN','Отправка видеозадания не подтверждена. Не запускайте его повторно');
  await createVideoCompletionDispatcher({
    queue:{...videoCompletionQueue,claim:async now=>{
      const job=await videoCompletionQueue.claimOne(operationKey,now);return job?[job]:[];
    }},resume:resumeQueuedVideo,
  })();
  const operation=await read();
  if(!operation)throw new AppError('AGENT_VIDEO_NOT_FOUND','Видеозадание больше недоступно');
  if(operation.deliveryState==='delivered'&&operation.file){
    return {status:'completed',operationKey,path:operation.file.path,delivery:{delivered:true,replayed:true}};
  }
  if(operation.deliveryState==='failed'||operation.deliveryState==='cancelled'||operation.status==='failed'){
    throw new AppError(operation.completionErrorCode??operation.errorCode??'AGENT_VIDEO_FAILED',
      'Доставка этого видео остановлена. Новая платная генерация не запускалась');
  }
  return {status:'pending',operationKey};
}
