/** Backend-only resumption of an already accepted video. No synthetic session or paid submit. */
import {resolveVideoCompletionDestination} from './video-migrated-destination.js';
import {isDeepStrictEqual} from 'node:util';
import {AppError} from '../app-error.js';
import {workspaceBinaryRepository} from '../workspaces/workspace-binary-repository.js';
import {sendAuthorizedWorkspaceFile} from '../workspaces/workspace-file-sender.js';
import {authorizeSpaceDelivery} from '../spaces/space-delivery-authorization.js';
import {isCurrentTelegramMember} from '../telegram-current-membership.js';
import {createVideoResumptionService,type VideoAccess} from './video-generation-service.js';
import {parseVideoCompletionOrigin,videoOriginTargetKey} from './video-completion-origin.js';
import {authorizeVideoCompletionOrigin} from './video-completion-access.js';
import {videoCompletionQueue,type ClaimedVideoCompletion} from './video-completion-queue.js';
import {videoOperationRepository} from './video-operation-repository.js';
import {videoBudgetRepository} from './video-budget-repository.js';
import {createOpenRouterVideoClient} from './openrouter-video-client.js';

interface Dependencies {
  resolveDestination:typeof resolveVideoCompletionDestination;
  assertLease:typeof videoCompletionQueue.assertLease;
  authorizeOrigin:typeof authorizeVideoCompletionOrigin;
  isMember:typeof isCurrentTelegramMember;
  authorizeAudience:typeof authorizeSpaceDelivery;
  workspaceId:typeof workspaceBinaryRepository.workspaceId;
  operations:Pick<typeof videoOperationRepository,'get'|'complete'|'fail'>;
  budget:Pick<typeof videoBudgetRepository,'settle'>;
  client:Pick<ReturnType<typeof createOpenRouterVideoClient>,'inspectStatus'|'download'>;
  binary:Pick<typeof workspaceBinaryRepository,'findBinaryWrite'|'writeBinary'>;
  send:typeof sendAuthorizedWorkspaceFile;
}
function changed():never{throw new AppError('AGENT_VIDEO_ACCESS_CHANGED','Исходная область видеозадания изменилась. Автодоставка остановлена');}
export function createVideoCompletionRuntime(deps:Dependencies){
  return async(job:ClaimedVideoCompletion)=>{
    const origin=parseVideoCompletionOrigin(job.origin);
    let destination=origin;
    let resolved=false;
    const authorize=async():Promise<VideoAccess>=>{
      await deps.assertLease(job);
      const next=await deps.resolveDestination(origin);
      if(resolved&&!isDeepStrictEqual(destination,next))changed();
      destination=next;resolved=true;
      const auth=destination.authorization;
      await deps.authorizeOrigin(destination);
      if(auth.groupId!==null&&!await deps.isMember(destination.target.chatId,origin.actorTelegramId)){
        throw new AppError('AGENT_VIDEO_COMPLETION_ACCESS_REVOKED','Участие автора видео в исходном чате не подтверждено');
      }
      const workspaceId=await deps.workspaceId(auth,origin.scope);
      if(workspaceId!==origin.workspaceId)changed();
      const access={workspaceId,scope:origin.scope,actorTelegramId:origin.actorTelegramId,targetKey:videoOriginTargetKey(origin)};
      const operation=await deps.operations.get(job.operationKey,workspaceId,access.targetKey,origin.actorTelegramId);
      if(!operation||!isDeepStrictEqual(operation.completionOrigin,origin))changed();
      const audience=await deps.authorizeAudience({familyId:auth.familyId,groupId:auth.groupId,
        chatType:auth.telegramChatType,userId:auth.userId,...(auth.space?{space:auth.space}:{}),now:new Date()});
      if(!audience.allowed)throw new AppError(audience.code,'Аудитория исходного чата видео не подтверждена');
      await deps.assertLease(job);
      return access;
    };
    return createVideoResumptionService({authorize,operations:deps.operations,budget:deps.budget,client:deps.client,
      files:{
        find:access=>deps.binary.findBinaryWrite(destination.authorization,access.scope,job.operationKey),
        write:(access,input)=>deps.binary.writeBinary(destination.authorization,{...input,scope:access.scope,mediaType:'video/mp4'}),
        deliver:(access,file,operationKey)=>deps.send({path:file.path,scope:access.scope,presentation:'document'}, {
          auth:destination.authorization,target:destination.target,operationKey,
          // A backend completion has no active conversation session. Journal entries explicitly
          // support that case; never revive a retired session or attach its private context.
          projection:{applicationSessionId:null,forumTopicId:destination.forumTopicId??null,replyToEntryId:null},
          beforeSend:async()=>{await authorize();},
        }),
      }})(job.operationKey);
  };
}
export async function resumeQueuedVideo(job:ClaimedVideoCompletion){
  const {inspectStatus,download}=createOpenRouterVideoClient({apiKey:process.env.OPENROUTER_VIDEO_API_KEY?.trim()??''});
  return createVideoCompletionRuntime({resolveDestination:resolveVideoCompletionDestination,assertLease:videoCompletionQueue.assertLease,authorizeOrigin:authorizeVideoCompletionOrigin,
    isMember:isCurrentTelegramMember,authorizeAudience:authorizeSpaceDelivery,workspaceId:workspaceBinaryRepository.workspaceId,
    operations:videoOperationRepository,budget:videoBudgetRepository,client:{inspectStatus,download},
    binary:workspaceBinaryRepository,send:sendAuthorizedWorkspaceFile})(job);
}
