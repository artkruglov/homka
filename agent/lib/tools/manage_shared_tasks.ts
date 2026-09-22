/**
 * Root-owned task lifecycle. The repository derives identity and scope from verified auth.
 *
 * Описание уходит в промпт каждого чата, где инструмент выдан, включая внешнюю группу по гранту,
 * поэтому здесь остаётся только протокол вызова. Раздел про дела, желания и традиции написан для
 * доверенных чатов и живёт в их блоке режима.
 */
import { defineTool } from "eve/tools";
import { currentTimeRepository } from "../current-time-repository.js";
import { requireMemoryAuthorization } from "../memory-context.js";
import { sharedTaskInput } from "../shared-tasks.js";
import { sharedTaskRepository } from "../shared-task-repository.js";
import { taskBoardReply, type BoardTask } from "../task-board.js";

export default defineTool({
  description: [
    "Планировщик дел, идей и традиций.",
    "create: title, kind task|idea|ritual (по умолчанию task), listName, details; срок dueAt или dueOn только у task. Идея и традиция не обязательство участников.",
    "В группе create с unassigned:true заводит свободное дело open без исполнителя; в личке свободных нет. claim с id берёт свободное, занятое взять нельзя.",
    "reopen с id возвращает закрытое по ошибке в работу (id из ответа закрытия или list view done). batch: items до 20 из create|complete|cancel|reopen|accept|decline|claim с полями этих действий, одно дело в пакете один раз. Несколько дел одного сообщения создавай и закрывай одним batch. Отказ любого пункта (AGENT_TASK_BATCH_REJECTED) отменяет весь пакет и называет номера пунктов: исправь их или спроси человека.",
    "Область выводится из текущего чата, личное не публикуй в группе. В личке list показывает мои назначения и запланированные мной идеи/традиции, в группе только её область.",
    "list без status даёт только незакрытое, view done закрытые; строки краткие, полная запись с details через get с id. board в ответе list это готовая доска для человека: на просьбу показать дела отправь её как есть.",
    "Фильтры list: status, listName, view mine|promised|waiting|open|today|ideas|rituals|planned|inbox|transfers|done. promised: что поручили мне другие; waiting: мои просьбы другим; open: свободные; today: срок или план на сегодня в поясе человека, просроченное первым; inbox: неразобранное без срока и плана (в группе без личного плана). planned и from/until YYYY-MM-DD только в личке. nextCursor передай как cursor; incomplete значит, что часть групп не проверена. lists: имена списков с источником, одинаковое имя в разных чатах это разные списки.",
    "plan: id, plannedFrom, plannedUntil YYYY-MM-DD, для дня равны; это личный период, не общий срок. unplan: id.",
    "update или clarify: id, version из list и изменения title/details/listName/dueAt/dueOn, null очищает поле. clarify по явной просьбе убирает из inbox, сохраняя originalText. Свободное правят читатели, принятое исполнитель. activate с id/version делает идею своим делом только по просьбе.",
    "careAreaRef связывает create с доступной областью заботы и сужает list до её дел.",
    "transfer: id, version, assigneeRef; до согласия отвечаю я, получатель в pendingAssignee. accept_transfer/decline_transfer отвечают, view transfers показывает входящие. release с id/version освобождает моё дело.",
    "Поручить другому: participants, затем create с assigneeRef; получатель сам принимает или отклоняет proposed, чужое согласие не выдумывай. complete только после accept, cancel автору и исполнителю.",
    "record: id традиции, occurredOn, note только о явно сообщённом опыте; history до 50 записей. Пропуск традиции не долг.",
    "Срок не создаёт уведомление. По просьбе в личке manage_reminder create с taskId и content равным title напоминает о моём принятом деле/традиции или проверяет ответ на мою просьбу proposed; завершение и отмена гасят сигналы. Если инструмента нет, скажи об этом.",
  ].join(" "),
  inputSchema: sharedTaskInput,
  async execute(input, ctx) {
    const auth = requireMemoryAuthorization(ctx);
    const result = await sharedTaskRepository.execute(auth, input, `${ctx.session.id}:${ctx.callId}`);
    // Доску собирает код: пересказанный моделью список приходил сплошным абзацем и прятался под кат.
    // Виды чужих обязательств (просьбы другим, входящие передачи) доской не оформляются: там
    // строки не про дела самого человека, и «Открытых дел: N» вводило бы в заблуждение.
    const ownList = input.action === "list" && !["transfers", "waiting"].includes(String(input.view ?? ""));
    const tasks = ownList ? (result as { tasks?: readonly BoardTask[] }).tasks : undefined;
    if (!tasks) return result;
    const timezone = await currentTimeRepository.findTurnTimezone(auth.userId, auth.familyId) ?? "UTC";
    return { ...result, board: taskBoardReply(tasks, new Date(), timezone) };
  },
});
