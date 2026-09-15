/** Shared-task input and state transitions. Identity is resolved by the repository. */
import { z } from "zod";
import { AppError } from "./app-error.js";

const date = z.iso.date().refine(value => {
  const d = new Date(value + "T00:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10) === value;
}, "Укажите существующую календарную дату");
export const sharedTaskInput = z.object({
  action: z.enum(["participants", "list", "lists", "create", "claim", "accept", "decline", "complete", "cancel", "transfer", "accept_transfer", "decline_transfer", "release", "update", "clarify", "plan", "unplan", "activate", "record", "history"]),
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
  view: z.enum(["mine","promised","waiting","open","today","transfers","ideas","rituals","planned","inbox"]).optional(),
  careAreaRef: z.uuid().optional(),
  cursor: z.string().max(300).optional(),
  id: z.uuid().optional(),
  status: z.enum(["open", "proposed", "accepted", "completed", "declined", "cancelled"]).optional(),
}).strict().superRefine((v, ctx) => {
  const fields: Record<string,string[]> = {
    create:["title","assigneeRef","unassigned","dueAt","dueOn","kind","listName","details","repeat","careAreaRef"],
    update:["id","version","title","dueAt","dueOn","listName","details"],
    clarify:["id","version","title","dueAt","dueOn","listName","details"],
    list:["status","view","listName","from","until","cursor","careAreaRef"], lists:[],
    plan:["id","plannedFrom","plannedUntil"], unplan:["id"], activate:["id","version"],
    record:["id","occurredOn","note"], history:["id"], participants:[],
    accept:["id"],decline:["id"],complete:["id"],cancel:["id"],claim:["id"],
    transfer:["id","version","assigneeRef"], accept_transfer:["id"], decline_transfer:["id"],
    release:["id","version"],
  };
  const fail = (message:string) => ctx.addIssue({code:"custom",message});
  for (const key of Object.keys(v)) if (key !== "action" && !fields[v.action]!.includes(key)) fail(`Недопустимое поле ${key}`);
  if (v.action === "create" && !v.title || !["participants","list","lists","create"].includes(v.action) && !v.id) fail("Нужны title для create или id для изменения записи");
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
});

export type SharedTaskInput = z.infer<typeof sharedTaskInput>;
export type SharedTaskStatus = NonNullable<SharedTaskInput["status"]>;

export function nextSharedTaskStatus(
  status: SharedTaskStatus, action: SharedTaskInput["action"], isAssignee: boolean, isCreator: boolean,
): SharedTaskStatus {
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
