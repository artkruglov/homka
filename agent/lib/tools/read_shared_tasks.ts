/**
 * Чтение дел для фонового обзора. Права менять у него нет вовсе.
 *
 * Фоновый ход и сабагент не получают планировщик целиком: подтвердить, поправить или остановить
 * их действие некому. Но обзор дня без чтения дел собрать нельзя, а отсутствие инструмента делало
 * его невозможным — критерий W18 требовал ровно обратного: читать, не имея права менять.
 *
 * Это не второй планировщик: тот же репозиторий, то же выведение области и личности из
 * проверенной авторизации, просто действие всегда одно и то же.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { requireMemoryAuthorization } from "../memory-context.js";
import { sharedTaskRepository } from "../shared-task-repository.js";

export const readSharedTasksInput = z.object({
  cursor: z.string().max(300).optional(),
  listName: z.string().trim().min(1).max(100).optional(),
  careAreaRef: z.uuid().optional(),
  view: z.enum(["mine", "promised", "waiting", "open", "today", "transfers", "ideas", "rituals", "planned", "inbox", "done"])
    .optional(),
}).strict();

export default defineTool({
  description: [
    "Прочитать дела текущей области для обзора. Менять их отсюда нельзя.",
    "view mine мои дела, promised что от меня ждут, waiting чего жду я, open свободные,",
    "today срок или личный план на сегодня и всё просроченное, transfers ожидающие передачи, ideas, rituals, planned.",
    "inbox: неразобранные идеи и дела без срока и плана. Без view показаны только незакрытые, view done показывает завершённые и отменённые.",
    "listName сужает до одного списка, nextCursor передай как cursor для следующей страницы.",
  ].join(" "),
  inputSchema: readSharedTasksInput,
  async execute(input, ctx) {
    const parsed = readSharedTasksInput.parse(input);
    return sharedTaskRepository.execute(
      requireMemoryAuthorization(ctx),
      { action: "list", ...parsed },
      `${ctx.session.id}:${ctx.callId}`,
    );
  },
});
