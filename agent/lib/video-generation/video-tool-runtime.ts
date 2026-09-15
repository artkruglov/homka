/** Verified Telegram and existing workspace/delivery adapters for the video service. */
import type {ToolContext,ToolDefinition} from 'eve/tools';
import {fileTypeFromBuffer} from 'file-type';
import {authorizeVideoCompletionOrigin} from './video-completion-access.js';
import {parseVideoCompletionOrigin} from './video-completion-origin.js';
import {AppError} from '../app-error.js';
import {resolveTelegramSessionActor} from '../telegram-session-actor.js';
import {requireWorkspaceAuthorization,requireTelegramDeliveryTarget} from '../workspaces/workspace-context.js';
import {workspaceBinaryRepository} from '../workspaces/workspace-binary-repository.js';
import {readImageReferenceAttachment} from '../image-generation/image-reference-attachment.js';
import sendWorkspaceFile from '../tools/send_workspace_file.js';
import {createVideoGenerationService,createVideoResumptionService,type VideoAccess} from './video-generation-service.js';
import {resumeCoordinatedVideo} from './video-completion-coordinator.js';
import {videoOperationRepository} from './video-operation-repository.js';
import {videoBudgetRepository} from './video-budget-repository.js';
import {createOpenRouterVideoClient} from './openrouter-video-client.js';
import {authorizeCurrentExternalGroupCapability} from '../tool-policy/external-group-live-policy.js';

export function createVideoAuthorization(ctx:ToolContext,workspaceId=workspaceBinaryRepository.workspaceId,
  authorizeGroup=authorizeCurrentExternalGroupCapability){
  const requireActiveTurn=()=>{
    if(ctx.abortSignal?.aborted)throw new AppError('AGENT_VIDEO_TURN_CANCELLED',
      'Ожидание видео остановлено. Уже заказанное видео можно проверить позже без новой генерации');
  };
  return async():Promise<VideoAccess>=>{
    requireActiveTurn();
    const attributes=ctx.session.auth.current?.attributes;
    const actor=resolveTelegramSessionActor(ctx.session.auth);
    if(ctx.session.parent||attributes?.scheduledRunId!==undefined||attributes?.memoryReviewBatchId!==undefined||
      !actor||actor.kind!=='telegram_user'||!/^[1-9][0-9]{0,18}$/u.test(actor.id)){
      throw new AppError('AGENT_VIDEO_INTERACTIVE_ONLY','Видео доступно в разговоре с человеком');
    }
    const auth=requireWorkspaceAuthorization(ctx);
    const scope=auth.telegramChatType==='private'&&auth.userId&&auth.groupId===null?'personal':
      auth.telegramChatType!=='private'&&auth.groupType==='family_private'&&auth.groupId&&auth.userId?'family':
      auth.telegramChatType!=='private'&&auth.groupType==='external'&&auth.groupId?'group':null;
    if(!scope)throw new AppError('AGENT_VIDEO_CHAT_UNSUPPORTED','Не удалось определить разрешённую область текущего чата для видео');
    // Family members retain their role in external chats; the chat's live grant still governs video.
    if(scope==='group')await authorizeGroup({familyId:auth.familyId,groupId:auth.groupId!},'generate_video');
    const target=requireTelegramDeliveryTarget(ctx);
    const id=await workspaceId(auth,scope);
    // Cancellation can arrive during database authorization, not only before it starts.
    requireActiveTurn();
    const completionOrigin=parseVideoCompletionOrigin({version:1,workspaceId:id,actorTelegramId:actor.id,scope,target,authorization:auth,
      forumTopicId:attributes?.telegramForumTopicId??null});
    await authorizeVideoCompletionOrigin(completionOrigin);
    requireActiveTurn();
    return {workspaceId:id,actorTelegramId:actor.id,scope,
      targetKey:`${target.chatId}:${target.messageThreadId??0}`,
      completionOrigin};
  };
}

export function createVideoToolRuntime(ctx:ToolContext){
  const authorize=createVideoAuthorization(ctx);
  const dependencies:Parameters<typeof createVideoGenerationService>[0]={authorize,operations:videoOperationRepository,budget:videoBudgetRepository,
    client:createOpenRouterVideoClient({apiKey:process.env.OPENROUTER_VIDEO_API_KEY?.trim()??''}),
    files:{
      find:(access,key)=>workspaceBinaryRepository.findBinaryWrite(requireWorkspaceAuthorization(ctx),access.scope,key),
      write:(access,input)=>workspaceBinaryRepository.writeBinary(requireWorkspaceAuthorization(ctx),{
        ...input,scope:access.scope,mediaType:'video/mp4'}),
      deliver:(access,file,deliveryKey)=>(sendWorkspaceFile as ToolDefinition<any,any>).execute({
        path:file.path,scope:access.scope,presentation:'document'}, {...ctx,callId:deliveryKey}) as Promise<unknown>,
    }};
  const legacyResume=createVideoResumptionService(dependencies);
  const service=createVideoGenerationService({...dependencies,resumeAccepted:async operationKey=>{
    const access=await authorize();
    const operation=await videoOperationRepository.get(operationKey,access.workspaceId,access.targetKey,access.actorTelegramId);
    return operation?.completionOrigin?resumeCoordinatedVideo(operationKey,access):legacyResume(operationKey);
  }});
  return {
    resume:service.resume,
    async cancelDelivery(operationKey:string){
      const access=await authorize();
      return videoOperationRepository.cancelDelivery(operationKey,access.workspaceId,access.targetKey,access.actorTelegramId);
    },
    async list(){
      const access=await authorize();
      const rows=await videoOperationRepository.list(access.workspaceId,access.targetKey,access.actorTelegramId);
      return {jobs:rows.map(row=>({jobRef:row.operationKey,status:row.status,deliveryState:row.deliveryState,diagnosticCode:row.completionErrorCode,model:row.model})),limit:20};
    },
    async balance(){const access=await authorize();return videoBudgetRepository.balance(access.actorTelegramId);},
    async start(input:{operationKey:string;prompt:string;duration:number;size:string;referencePath?:string;referenceAttachmentId?:string}){
      const access=await authorize();
      let firstFrame;
      if(input.referencePath||input.referenceAttachmentId){
        const auth=requireWorkspaceAuthorization(ctx);
        const bytes=input.referencePath?(await workspaceBinaryRepository.readBinary(auth,access.scope,input.referencePath)).bytes:
          await readImageReferenceAttachment(auth,input.referenceAttachmentId!);
        const type=bytes.length<=8*1024*1024?await fileTypeFromBuffer(bytes):undefined;
        if(!type||!['image/png','image/jpeg','image/webp'].includes(type.mime)){
          throw new AppError('AGENT_VIDEO_REFERENCE_INVALID','Нужна фотография PNG, JPEG или WebP размером до 8 МБ');
        }
        firstFrame={bytes,mediaType:type.mime as 'image/png'|'image/jpeg'|'image/webp'};
      }
      return service.start({...input,...(firstFrame?{firstFrame}:{})});
    },
  };
}
