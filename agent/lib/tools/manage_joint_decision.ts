/** Consent and feedback are interactive root actions with backend-derived identity. */
import { defineTool } from "eve/tools";
import { AppError } from "../app-error.js";
import { requireMemoryAuthorization } from "../memory-context.js";
import { decisionInput } from "../joint-decisions/joint-decision-contract.js";
import { jointDecisionRepository } from "../joint-decisions/joint-decision-repository.js";

export default defineTool({
  description:[
    "Совместное решение двух участников и добровольный отзыв. Работает в выбранной общей области или семейном чате; из личной области сначала попроси выбрать общую через manage_space, не публикуй личный контекст автоматически.",
    "participants возвращает name и participantRef. create: partnerRef другого человека, title и необязательные details публичного предложения. Текст и участники неизменяемы: для изменения создай новое предложение. Создание не является согласием даже автора.",
    "list показывает до 50 решений области, truncated означает неполный список; get с id читает одно. Перед изменением прочитай get и возьми текущую version. answer: id, version, choice agree|decline только по явному ответу текущего человека. Никогда не отвечай за второго, не считай молчание согласием. Согласовано только status agreed после двух явных agree; open ждёт ответа, declined означает отказ, cancelled отменено.",
    "cancel с id/version доступен автору предложения. feedback с id/version/text сохраняет только добровольно высказанный текущим человеком отзыв в этой общей области. Не копируй личную беседу и не оценивай вклад семьи. withdraw_feedback с id/version удаляет только собственный отзыв. Отзыв не является согласием.",
    "Решение само не создаёт покупку, бронирование, календарное событие или чужую задачу. Для таких действий нужен отдельный явный запрос и соответствующий инструмент.",
  ].join(" "),
  inputSchema:decisionInput,
  async execute(input,ctx){
    const attributes=ctx.session.auth.current?.attributes;
    if(ctx.session.parent || !["private","group","supergroup"].includes(String(attributes?.telegramChatType))
      || attributes?.scheduledRunId!==undefined || attributes?.memoryReviewBatchId!==undefined){
      throw new AppError("AGENT_DECISION_INTERACTIVE_ONLY","Решения и отзывы доступны в текущем разговоре с человеком");
    }
    return jointDecisionRepository.execute(requireMemoryAuthorization(ctx),input,`${ctx.session.id}:${ctx.callId}`);
  },
});
