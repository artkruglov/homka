/** Shared durable file delivery for interactive tools and authorized backend completion.
 * Uses the existing ledger and Telegram transport; background callers never forge ToolContext.
 */
import {requireWorkspaceFileDestination} from './workspace-file-destination.js';
import {basename} from 'node:path';
import {AppError,isAppError} from '../app-error.js';
import {deliverWorkspaceFile} from '../attachments/telegram-workspace-file-delivery.js';
import {workspaceFileDeliveryRepository} from './workspace-file-delivery-repository.js';
import type {WorkspaceAuthorization,WorkspaceScope} from './workspace-repository.js';
import {telegramGroupJournalRepository} from '../telegram-group-journal-repository.js';
import {registerTelegramMessageRoutes} from '../sessions/session-context.js';
import {authorizeSpaceDelivery} from '../spaces/space-delivery-authorization.js';

interface FileInput {path:string;scope:WorkspaceScope;presentation:'photo'|'document';caption?:string}
interface DeliveryContext {
  auth:WorkspaceAuthorization;
  target:{chatId:string;messageThreadId?:number};
  operationKey:string;
  /** `<eve session>:<turn>`: identical bytes already sent to this chat in this turn are not resent. */
  turnId?:string|null;
  projection:{applicationSessionId:string|null;forumTopicId:string|null;replyToEntryId:string|null};
  /** Extra live guard, e.g. a completion lease; audience checks always run independently. */
  beforeSend?:()=>Promise<void>;
}
export async function sendAuthorizedWorkspaceFile(input:FileInput,deliveryContext:DeliveryContext){
  const {auth,target}=deliveryContext;
  const topic=deliveryContext.projection.forumTopicId;
  if(topic!==null&&!/^[1-9][0-9]*$/u.test(topic))throw new AppError(
    'AGENT_TELEGRAM_FORUM_TOPIC_INVALID','Не удалось определить тему для истории отправленного файла');
  const checkDelivery=async()=>{
    await requireWorkspaceFileDestination(auth,target.chatId);
    const decision=await authorizeSpaceDelivery({chatType:auth.telegramChatType,familyId:auth.familyId,
      groupId:auth.groupId,userId:auth.userId,...(auth.space?{space:auth.space}:{}),now:new Date()});
    if(!decision.allowed)throw new AppError(decision.code,'Отправка файла остановлена: доступ к аудитории не подтверждён');
    await deliveryContext.beforeSend?.();
  };
  await checkDelivery();
    const reservation = await workspaceFileDeliveryRepository.begin(auth, {
      ...target,
      operationKey: deliveryContext.operationKey,
      path: input.path,
      presentation: input.presentation,
      scope: input.scope,
      turnId: deliveryContext.turnId ?? null,
    });
    // These bytes reached this chat earlier in the turn under another call (upstream 61363db): the
    // journal and message routes were recorded then, so only point at that message.
    if (reservation.status === "duplicate") {
      return {
        alreadySent: true,
        delivered: true,
        path: reservation.file.path,
        persistenceCompleted: true,
        projectionCompleted: true,
        replayed: false,
        retryable: false,
        scope: reservation.file.scope,
        sideEffectStatus: "completed" as const,
        telegramMessageId: reservation.telegramMessageId,
      };
    }
    const replayed = reservation.status === "completed";
    let persistenceCompleted = replayed;
    let delivery: { telegramMessageId: string };
    if (replayed) {
      delivery = { telegramMessageId: reservation.telegramMessageId };
    } else {
      try {
        await checkDelivery();
        delivery = await deliverWorkspaceFile({
          bytes: reservation.bytes,
          ...(input.caption === undefined ? {} : { caption: input.caption }),
          ...target,
          fileName: basename(reservation.file.path),
          mediaType: reservation.file.mediaType,
          presentation: input.presentation,
        });
      } catch (error) {
        // Definitive validation/provider failures may be retried only through a new user request.
        if (isAppError(error) && error.code !== "AGENT_WORKSPACE_FILE_DELIVERY_AMBIGUOUS") {
          await workspaceFileDeliveryRepository.fail(deliveryContext.operationKey, error.code);
        }
        throw error;
      }
      try {
        await workspaceFileDeliveryRepository.complete(deliveryContext.operationKey, delivery.telegramMessageId);
        persistenceCompleted = true;
      } catch (error) {
        // Telegram confirmed delivery, so a bookkeeping error must not turn into a retryable send.
        console.error(JSON.stringify({
          code: "AGENT_WORKSPACE_FILE_COMPLETION_FAILED",
          error: error instanceof Error ? error.message : String(error),
          telegramMessageId: delivery.telegramMessageId,
        }));
      }
    }
    let projectionCompleted = true;
    if (auth.groupId !== null) {
      const sessionId = deliveryContext.projection.applicationSessionId;
      const fileName = basename(reservation.file.path);
      // Tool deliveries bypass Telegram channel events, so project the confirmed side effect and
      // bind its message ID before a participant can reply to it.
      try {
        await telegramGroupJournalRepository.recordAgentResponse({
          applicationSessionId: sessionId,
          attachment: {
            fileName,
            kind: input.presentation,
            mediaType: reservation.file.mediaType,
            size: reservation.bytes.byteLength,
          },
          contentText: input.caption?.trim() || `Отправлен файл «${fileName}».`,
          deliveredAt: new Date(),
          groupId: auth.groupId,
          messageThreadId: deliveryContext.projection.forumTopicId,
          replyToEntryId: deliveryContext.projection.replyToEntryId,
          telegramMessageIds: [delivery.telegramMessageId],
        });
        if (sessionId !== null) await registerTelegramMessageRoutes({
          applicationSessionId: sessionId,
          chatId: target.chatId,
          messageIds: [delivery.telegramMessageId],
          ...(target.messageThreadId === undefined
            ? {}
            : { messageThreadId: target.messageThreadId }),
        });
      } catch (error) {
        // Telegram already confirmed the side effect; surfacing an error would invite a duplicate send.
        projectionCompleted = false;
        console.error(JSON.stringify({
          code: "AGENT_WORKSPACE_FILE_PROJECTION_FAILED",
          error: error instanceof Error ? error.message : String(error),
          telegramMessageId: delivery.telegramMessageId,
        }));
      }
    }
    return {
      alreadySent: false,
      delivered: true,
      path: reservation.file.path,
      persistenceCompleted,
      projectionCompleted,
      replayed,
      retryable: false,
      scope: reservation.file.scope,
      sideEffectStatus: "completed" as const,
      telegramMessageId: delivery.telegramMessageId,
    };
}
