/** Shared-task input and state transitions. Identity is resolved by the repository. */
import { z } from "zod";
import { AppError } from "./app-error.js";

const date = z.iso.date().refine(value => {
  const d = new Date(value + "T00:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10) === value;
}, "Укажите существующую календарную дату");
/** Открытая работа: то, что список показывает, пока человек не попросил завершённое. */
export const UNFINISHED_TASK_STATUSES: readonly string[] = ["open", "proposed", "accepted"];
/** Завершённые: отдельное представление «Завершённые», а не хвост общего списка. */
export const CLOSED_TASK_STATUSES: readonly string[] = ["completed", "cancelled", "declined"];
/** Пакет меняет несколько дел одним вызовом: список из сообщения создаётся или закрывается целиком. */
export const BATCH_ITEM_ACTIONS: readonly string[] = ["create", "claim", "accept", "decline", "complete", "cancel", "reopen"];
export const BATCH_MAX_ITEMS = 20;

const sharedTaskFields = z.object({
  action: z.enum(["participants", "list", "lists", "get", "batch", "create", "claim", "accept", "decline", "complete", "cancel", "reopen", "transfer", "accept_transfer", "decline_transfer", "release", "update", "clarify", "plan", "unplan", "activate", "record", "history"]),
  title: z.string().trim().min(1).max(1000).optional(),
  assigneeRef: z.uuid().optional(),
  /** Дело без исполнителя: вопрос «кто возьмёт», а не назначение автору. */
  unassigned: z.literal(true).optional(),
  /** Правило повтора дела: календарное или «через столько-то после выполнения». */
  repeat: z.object({
    interval: z.number().int().min(1).max(365),
    unit: z.enum(["daily", "weekly", "monthly", "after_completion"]),
  }).strict().nullable().optional(),
  dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
  dueOn: date.nullable().optional(),
  kind: z.enum(["task","idea","ritual"]).optional(),
  listName: z.string().trim().min(1).max(100).nullable().optional(),
  details: z.string().trim().max(4000).nullable().optional(),
  version: z.number().int().positive().optional(),
  plannedFrom: date.optional(), plannedUntil: date.optional(),
  from: date.optional(), until: date.optional(),
  occurredOn: date.optional(), note: z.string().trim().min(1).max(1000).optional(),
  view: z.enum(["mine","promised","waiting","open","today","transfers","ideas","rituals","planned","inbox","done"]).optional(),
  careAreaRef: z.uuid().optional(),
  cursor: z.string().max(300).optional(),
  id: z.uuid().optional(),
  status: z.enum(["open", "proposed", "accepted", "completed", "declined", "cancelled"]).optional(),
});
type SharedTaskFields = z.infer<typeof sharedTaskFields> & { items?: unknown[] };

function checkSharedTaskFields(v: SharedTaskFields, ctx: z.RefinementCtx) {
  const fields: Record<string,string[]> = {
    batch:["items"],
    create:["title","assigneeRef","unassigned","dueAt","dueOn","kind","listName","details","repeat","careAreaRef"],
    update:["id","version","title","dueAt","dueOn","listName","details"],
    clarify:["id","version","title","dueAt","dueOn","listName","details"],
    list:["status","view","listName","from","until","cursor","careAreaRef"], lists:[], get:["id"],
    plan:["id","plannedFrom","plannedUntil"], unplan:["id"], activate:["id","version"],
    record:["id","occurredOn","note"], history:["id"], participants:[],
    // version необязателен: модель передаёт прочитанную в list, и тогда устаревшее изменение отвергается.
    accept:["id","version"],decline:["id","version"],complete:["id","version"],cancel:["id","version"],claim:["id","version"],
    reopen:["id","version"],
    transfer:["id","version","assigneeRef"], accept_transfer:["id"], decline_transfer:["id"],
    release:["id","version"],
  };
  const fail = (message:string) => ctx.addIssue({code:"custom",message});
  for (const key of Object.keys(v)) if (key !== "action" && !fields[v.action]!.includes(key)) fail(`Недопустимое поле ${key}`);
  if (v.action === "create" && !v.title || !["participants","list","lists","create","batch"].includes(v.action) && !v.id) fail("Нужны title для create или id для изменения записи");
  if (["update","clarify","activate","transfer","release"].includes(v.action) && !v.version) fail("Прочитайте актуальную version через list");
  if (v.action === "transfer" && !v.assigneeRef) fail("Для transfer укажите assigneeRef из participants");
  if (v.action === "update" && !["title","details","dueAt","dueOn","listName"].some(k => k in v)) fail("Укажите изменения");
  if (v.dueAt && v.dueOn) fail("Срок бывает датой либо точным временем");
  if (v.unassigned && (v.assigneeRef || (v.kind && v.kind !== "task"))) {
    fail("Свободным бывает только дело и только без указанного исполнителя");
  }
  // Повтор считается по календарным датам: у дела нет своего часового пояса.
  if (v.repeat && (!v.dueOn || v.dueAt || (v.kind && v.kind !== "task"))) {
    fail("Повторяющееся дело задаётся датой dueOn, без точного времени");
  }
  if (v.kind && v.kind !== "task" && (v.dueAt || v.dueOn || v.assigneeRef)) fail("Идеи и традиции не назначаются другому и не имеют срока");
  if (v.action === "plan" && (!v.plannedFrom || !v.plannedUntil || v.plannedFrom > v.plannedUntil)) fail("Нужен корректный период plannedFrom..plannedUntil");
  if ((v.from || v.until) && (!v.from || !v.until || v.from > v.until)) fail("Нужен корректный период from..until");
  if (v.action === "record" && (!v.occurredOn || !v.note)) fail("Укажите occurredOn и note");
  if (v.view === "done" && v.status && !CLOSED_TASK_STATUSES.includes(v.status)) fail("В завершённых нет незакрытых дел");
}

/** Элемент пакета проверяется теми же правилами, что и одиночный вызов этого действия. */
const sharedTaskBatchItem = sharedTaskFields.strict().superRefine((v, ctx) => {
  if (!BATCH_ITEM_ACTIONS.includes(v.action)) {
    ctx.addIssue({code:"custom",message:`В пакете допустимы ${BATCH_ITEM_ACTIONS.join(", ")}`});
  }
  checkSharedTaskFields(v, ctx);
});

export const sharedTaskInput = sharedTaskFields.extend({
  items: z.array(sharedTaskBatchItem).min(1).max(BATCH_MAX_ITEMS).optional(),
}).strict().superRefine((v, ctx) => {
  checkSharedTaskFields(v, ctx);
  if (v.action !== "batch") return;
  if (!v.items) ctx.addIssue({code:"custom",message:"Для batch нужен список items"});
  const ids = (v.items ?? []).flatMap((item) => item.id ? [item.id] : []);
  // Два действия над одним делом в одном пакете зависели бы от порядка исполнения.
  if (new Set(ids).size !== ids.length) ctx.addIssue({code:"custom",message:"Одно дело встречается в пакете дважды"});
});

export type SharedTaskInput = z.infer<typeof sharedTaskInput>;
export type SharedTaskStatus = NonNullable<SharedTaskInput["status"]>;

export function nextSharedTaskStatus(
  status: SharedTaskStatus, action: SharedTaskInput["action"], isAssignee: boolean, isCreator: boolean,
): SharedTaskStatus {
  // Закрытое по ошибке возвращается в работу. Отказ получателя (declined) не переоткрывается: это его
  // решение. Чужое поручение автор возвращает предложенным: принять его снова должен исполнитель.
  if (action === "reopen") {
    if ((status === "completed" || status === "cancelled") && (isAssignee || isCreator)) {
      return isAssignee ? "accepted" : "proposed";
    }
    throw new AppError("AGENT_TASK_TRANSITION_DENIED", "Вернуть в работу можно только своё завершённое или отменённое дело");
  }
  // Взять можно только свободное дело. Второй «беру» встречает уже занятое и получает отказ:
  // строка к этому моменту заблокирована, поэтому победитель ровно один.
  if (status === "open" && action === "claim") return "accepted";
  // Отказ исполнителя делает отсутствие ответственного видимым, а не назначает никого другого.
  if (status === "accepted" && isAssignee && action === "release") return "open";
  // Передача меняет исполнителя, а не состояние: дело как было принятым, так и осталось.
  if (status === "accepted" && ["transfer", "accept_transfer", "decline_transfer"].includes(action)) {
    return "accepted";
  }
  if (status === "proposed" && isAssignee && action === "accept") return "accepted";
  if (status === "proposed" && isAssignee && action === "decline") return "declined";
  if (status === "accepted" && isAssignee && action === "complete") return "completed";
  if (["proposed", "accepted"].includes(status) && (isCreator || isAssignee) && action === "cancel") return "cancelled";
  throw new AppError("AGENT_TASK_TRANSITION_DENIED", "Это действие недоступно вам или текущему состоянию задачи");
}
