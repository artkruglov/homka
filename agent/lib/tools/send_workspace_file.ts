/**
 * Workspace-to-Telegram file sender tool.
 *
 * Export:
 * - Eve `send_workspace_file` tool with current-scope authorization and durable delivery guard.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { AppError } from "../app-error.js";
import {sendAuthorizedWorkspaceFile} from "../workspaces/workspace-file-sender.js";
import {
  requireTelegramDeliveryTarget,
  requireWorkspaceAuthorization,
} from "../workspaces/workspace-context.js";
import {
  applicationSessionId,
} from "../sessions/session-context.js";

export default defineTool({
  description: [
    "Когда использовать: отправить уже существующий файл из доступного workspace в текущий Telegram-чат или тему.",
    "Не использовать: не создаёт файл и не принимает абсолютный sandbox path.",
    "Вход: path относительно корня выбранного scope, например reports/result.pdf; не добавляй personal, family или group в начало пути. presentation выбирает document или photo.",
    "Результат: delivered=true, telegramMessageId, path, scope и replayed; alreadySent=true означает, что эти же байты уже ушли в этот чат на этом ходе (например, из generate_image) и повторно ничего не отправлено; persistenceCompleted=false или projectionCompleted=false означает, что файл уже отправлен, но служебный учёт обновился не полностью.",
    "Ошибка: если sideEffectStatus=unknown или completed, не отправляй файл повторно без нового запроса пользователя.",
  ].join(" "),
  inputSchema: z.object({
    caption: z.string().max(1_024).optional().describe("Необязательная подпись Telegram"),
    path: z.string().min(1).max(512).describe("Относительный путь внутри выбранного scope"),
    presentation: z.enum(["document", "photo"]).describe("Способ отправки в Telegram"),
    scope: z.enum(["personal", "family", "group"]).describe("Workspace, относительно которого задан path"),
  }).strict(),
  async execute(input, ctx) {
    const auth = requireWorkspaceAuthorization(ctx);
    const target = requireTelegramDeliveryTarget(ctx);
    const forumTopicId = ctx.session.auth.current?.attributes.telegramForumTopicId;
    if (forumTopicId !== undefined &&
      (typeof forumTopicId !== "string" || !/^[1-9][0-9]*$/u.test(forumTopicId))) {
      throw new AppError(
        "AGENT_TELEGRAM_FORUM_TOPIC_INVALID",
        "Не удалось определить тему для истории отправленного файла",
      );
    }
    return sendAuthorizedWorkspaceFile(input, {
      auth, target, operationKey:ctx.callId,
      // Two calls of one turn carry two call ids; the turn recognises the same bytes sent twice.
      turnId:`${ctx.session.id}:${ctx.session.turn.id}`,
      projection: {
        applicationSessionId:auth.groupId===null?null:applicationSessionId(ctx),
        forumTopicId:typeof forumTopicId==='string'?forumTopicId:null,
        replyToEntryId:typeof ctx.session.auth.current?.attributes.telegramTimelineEntryId==='string'
          ?ctx.session.auth.current.attributes.telegramTimelineEntryId:null,
      },
    });
  },
});
