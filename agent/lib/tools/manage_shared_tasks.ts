/**
 * Root-owned task lifecycle. The repository derives identity and scope from verified auth.
 *
 * Описание уходит в промпт каждого чата, где инструмент выдан, включая внешнюю группу по гранту,
 * поэтому здесь остаётся только протокол вызова. Раздел про дела, желания и традиции написан для
 * доверенных чатов и живёт в их блоке режима.
 */
import { defineTool } from "eve/tools";
import { requireMemoryAuthorization } from "../memory-context.js";
import { sharedTaskInput } from "../shared-tasks.js";
import { sharedTaskRepository } from "../shared-task-repository.js";

export default defineTool({
  description: [
    "Планировщик дел, идей и традиций.",
    "create: title, kind task|idea|ritual (по умолчанию task), listName, details; только task имеет dueAt или dueOn. Идеи и традиции не являются обязательствами всех участников.",
    "create с unassigned:true в группе заводит свободное дело open без назначения автору. В личке свободных дел нет. claim с id забирает свободное дело; занятое взять нельзя. view open показывает свободные дела, today срок или личный план на сегодня в поясе человека и просроченное первым.",
    "Область выводится из текущего чата. Личное не публикуй в группе. В личке list показывает мои назначения и запланированные мной идеи/традиции; view waiting показывает мои просьбы другим. В группе только ее область.",
    "list: status, listName, view mine|promised|waiting|open|today|ideas|rituals|planned; view promised показывает дела, которые поручил мне другой человек, то есть что от меня ждут; planned и from/until YYYY-MM-DD фильтруют мой период только в личке. nextCursor передай как cursor для следующей страницы; incomplete означает неполную проверку групп. lists возвращает все имена списков области вместе с источником: одинаковое имя в разных чатах это разные списки.",
    "plan: id, plannedFrom и plannedUntil YYYY-MM-DD; для дня они равны, для недели/месяца/квартала укажи границы. Это личный выбор периода, не общий срок. unplan: id.",
    "update или clarify: id, version из list, изменения title/details/listName/dueAt/dueOn; null очищает поле. clarify по явной просьбе убирает из inbox, сохраняя originalText и вид записи. inbox показывает неразобранные идеи/дела без срока и личного плана; в группе личный план не учитывается. Свободное правят читатели, принятое исполнитель. activate с id/version превращает идею в свое дело только по просьбе.",
    "careAreaRef связывает create с доступной областью заботы и сужает list до ее дел; ссылка возвращается у каждой связанной задачи.",
    "transfer: id, version, assigneeRef. Предлагает подмену: до согласия отвечаю я, получатель в pendingAssignee. accept_transfer/decline_transfer отвечают на запрос, view transfers читает мои входящие передачи. release с id/version освобождает мое дело без назначения другому.",
    "Для поручения другому task сначала participants, затем create с assigneeRef. Получатель сам принимает или отклоняет proposed. complete только после accept; cancel доступно автору и исполнителю. Чужое согласие не выдумывай.",
    "record: id традиции, occurredOn YYYY-MM-DD, note о собственном опыте; history читает до 50 последних записей. Пиши только явно сообщенный опыт в текущую область. Пропуск традиции не долг и не повод для оценки семьи.",
    "Срок не создает уведомление. По просьбе в личке manage_reminder create с taskId и content равным title напомнит о своем принятом деле/традиции или проверит ответ на свою просьбу proposed. Ответ останавливает проверку; завершение/отмена сигналы о деле. Если инструмент отсутствует, скажи об этом.",
  ].join(" "),
  inputSchema: sharedTaskInput,
  async execute(input, ctx) {
    return sharedTaskRepository.execute(requireMemoryAuthorization(ctx), input, `${ctx.session.id}:${ctx.callId}`);
  },
});
