/**
 * Передача сообщения в другой чат по просьбе человека.
 *
 * Экспорт:
 * - `send_to_chat`: список доступных чатов и сама передача после подтверждения.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { AppError } from "../app-error.js";
import { requireMemoryAuthorization } from "../memory-context.js";
import { createChatRelay, listRelayTargets } from "../relay/chat-relay-repository.js";
import { relayChatMessage } from "../relay/chat-relay-transport.js";
import { isCurrentTelegramMember } from "../telegram-current-membership.js";

const relay = createChatRelay({ membership: isCurrentTelegramMember, send: relayChatMessage });

export const sendToChatInput = z.object({
  action: z.enum(["targets", "send"]),
  targetRef: z.uuid().optional(),
  text: z.string().trim().min(1).max(1500).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.action === "targets" && (value.targetRef || value.text)) {
    ctx.addIssue({ code: "custom", message: "Для targets не передавай полей" });
  }
  if (value.action === "send" && (!value.targetRef || !value.text)) {
    ctx.addIssue({ code: "custom", message: "Для send нужны targetRef из targets и text" });
  }
});

export default defineTool({
  approval: ({ toolInput }) => {
    const parsed = sendToChatInput.safeParse(toolInput);
    if (!parsed.success) {
      throw new AppError("AGENT_RELAY_INPUT_INVALID", "Проверьте адресата и текст сообщения");
    }
    // Показать список чатов можно без подтверждения; отправку подтверждает человек, видя текст.
    return parsed.data.action === "send" ? "user-approval" : "not-applicable";
  },
  description: [
    "Передать сообщение в другой чат этого человека: targets показывает доступные чаты, send передаёт текст.",
    "send: targetRef ровно из последнего targets и text, который человек подтвердит перед отправкой. Не угадывай чат по названию и не пересказывай своими словами то, что просили передать дословно.",
    "Сообщение уходит с подписью, чья это просьба: в общем чате видно автора, а не только помощницу.",
    "Пиши только то, о чём попросили: это не способ переслать личную переписку и не повод добавлять контекст, которого в просьбе не было.",
  ].join(" "),
  inputSchema: sendToChatInput,
  async execute(input, ctx) {
    const auth = requireMemoryAuthorization(ctx);
    if (input.action === "targets") return { targets: await listRelayTargets(auth) };
    return await relay(auth, { targetRef: input.targetRef!, text: input.text! },
      `${ctx.session.id}:${ctx.callId}`);
  },
});
