/** Private root tool. Source text comes from the verified turn, never from model-supplied identity. */
import { defineTool } from "eve/tools";
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { requireMemoryAuthorization } from "../memory-context.js";
import { resolveMemoryTurnSource } from "../memory-turn-source.js";
import { errandToolInput } from "../errands/errand-contract.js";
import { errandRepository } from "../errands/errand-repository.js";
import { createErrandResearchService } from "../errands/errand-research-service.js";
import { runErrandResearch } from "../errands/errand-research-runner.js";
import { errandResearchModel } from "../model-registry.js";
import { modelProviderConfig } from "../model-provider-config.js";

const researchErrand = createErrandResearchService(brief => runErrandResearch(errandResearchModel, brief));

export default defineTool({
  description: [
    "Личное поручение: подготовить подборку и по явной просьбе отправить одному подтверждённому участнику семьи.",
    "recipients возвращает имена и recipientRef. create: recipientRef, brief с минимальной публичной задачей, mode draft для подготовки или send только если человек попросил отправить. Получатель и brief затем неизменяемы.",
    "research: id и текущая version. Backend сам исследует сохранённый публичный brief через поиск и записывает результат. Не передавай готовый текст, историю, причины или жалобы; не используй для поручения обычный agent. В brief при создании оставляй только публичную задачу без личного обоснования. При неизвестном исходе исследования не создавай новое поручение для автоматического повтора.",
    "draft не отправляется: после явной просьбы send с id/version. mode send ставит готовый результат в очередь; повторного подтверждения не нужно. get с id и list view sent|received показывают состояние. researchState started/ambiguous означает отсутствие подтверждённого результата поиска; не повторяй поиск автоматически. Только sent подтверждает доставку; queued ждёт условий, sending/ambiguous не подтверждены, повторять их нельзя. cancel действует до начала отправки.",
    "Если человек отвечает на полученную подборку, сначала list view received и get; при нескольких подходящих уточни. Его беседа остаётся личной. Только явное передай мой ответ разрешает share_answer: id, resultVersion, text. Ответ становится доступен инициатору через get; это не создание задачи, покупка или бронирование.",
  ].join(" "),
  inputSchema: errandToolInput,
  async execute(input,ctx) {
    const attributes = ctx.session.auth.current?.attributes;
    if (ctx.session.parent !== undefined || attributes?.telegramChatType !== "private" ||
      attributes.scheduledRunId !== undefined || attributes.memoryReviewBatchId !== undefined) {
      throw new AppError("AGENT_ERRAND_PRIVATE_ONLY", "Поручения доступны в личном разговоре с человеком");
    }
    const auth = requireMemoryAuthorization(ctx);
    if (input.action === "research") {
      if (modelProviderConfig.provider !== "deepseek") {
        throw new AppError("AGENT_ERRAND_RESEARCH_PROVIDER_UNAVAILABLE", "Исследование поручений требует настроенного DeepSeek с поиском");
      }
      return researchErrand(auth,input,{operationKey:`${ctx.session.id}:${ctx.callId}`,
        sessionId:ctx.session.id,turnId:ctx.session.turn.id,privateQuery:""});
    }
    let privateQuery = "";
    if (input.action === "create") {
      const source = await resolveMemoryTurnSource(ctx,auth);
      if (!source.isCurrent || source.isReview) throw new AppError("AGENT_ERRAND_SOURCE_REQUIRED", "Нужен текущий запрос человека");
      const row = (await database().query<{content_text:string}>(`SELECT m.content_text FROM telegram_group_messages m
        JOIN application_conversations c ON c.id=m.conversation_id
        WHERE m.id=$1 AND c.id=$2 AND c.family_id=$3 AND c.scope='personal'
          AND c.owner_user_id=$4 AND m.telegram_user_id=$5 AND m.actor_kind='user'`,
      [source.timelineEntryId,source.conversationId,auth.familyId,auth.userId,auth.telegramUserId])).rows[0];
      if (!row?.content_text) throw new AppError("AGENT_ERRAND_SOURCE_REQUIRED", "Исходное сообщение недоступно");
      privateQuery = row.content_text;
    }
    return errandRepository.execute(auth,input,{operationKey:`${ctx.session.id}:${ctx.callId}`,
      sessionId:ctx.session.id,turnId:ctx.session.turn.id,privateQuery});
  },
});
