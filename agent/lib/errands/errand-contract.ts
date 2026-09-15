/** Errand intent, state transitions and route-free model input. Identity stays in the backend. */
import { z } from "zod";
import { AppError } from "../app-error.js";

export type ErrandState = "preparing" | "ready" | "queued" | "sending" | "sent" |
  "failed" | "ambiguous" | "cancelled";
export type ErrandEvent = "result" | "send" | "cancel" | "start_delivery" |
  "delivered" | "failed" | "ambiguous";

export function nextErrandState(
  state: ErrandState, event: ErrandEvent, deliveryAuthorized: boolean,
): ErrandState {
  if (["preparing", "ready", "queued"].includes(state) && event === "cancel") return "cancelled";
  if (["preparing", "ready", "queued"].includes(state) && event === "result") {
    return deliveryAuthorized ? "queued" : "ready";
  }
  if (state === "ready" && event === "send") return "queued";
  if (state === "queued" && event === "start_delivery" && deliveryAuthorized) return "sending";
  if (state === "sending") {
    if (event === "delivered") return "sent";
    if (event === "failed") return "failed";
    if (event === "ambiguous") return "ambiguous";
  }
  throw new AppError("AGENT_ERRAND_TRANSITION_DENIED",
    "Это действие уже невозможно: проверьте состояние поручения. Не повторяйте неизвестную отправку");
}

// Storage is independent of Telegram message size; detailed results use one document.
export const ERRAND_RESEARCH_TEXT_MAX = 32_000;

const source = z.object({
  url: z.url().max(2000).refine(value => ["https:", "http:"].includes(new URL(value).protocol),
    "Источник должен быть веб-страницей"),
  checkedAt: z.iso.datetime({ offset: true }),
}).strict();

export const errandResearchResult = z.object({
  text: z.string().trim().min(1).max(ERRAND_RESEARCH_TEXT_MAX),
  sources: z.array(source).min(1).max(10),
}).strict();

const errandFields = z.object({
  action: z.enum(["recipients", "list", "create", "get", "result", "send", "cancel", "share_answer"]),
  id: z.uuid().optional(),
  recipientRef: z.uuid().optional(),
  brief: z.string().trim().min(1).max(1500).optional(),
  mode: z.enum(["draft", "send"]).optional(),
  version: z.number().int().positive().optional(),
  resultVersion: z.number().int().positive().optional(),
  text: z.string().trim().min(1).max(ERRAND_RESEARCH_TEXT_MAX).optional(),
  sources: z.array(source).max(10).optional(),
  view: z.enum(["sent", "received"]).optional(),
}).strict();

function validateFields(value: z.infer<typeof errandFields> | {action: "research";id:string;version:number}, ctx: z.RefinementCtx) {
  if (value.action === "share_answer" && value.text && value.text.length > 3000) {
    ctx.addIssue({ code: "custom", path: ["text"], message: "Ответ должен быть не длиннее 3000 символов" });
  }
  const fields: Record<string, string[]> = {
    research: ["id", "version"], recipients: [], list: ["view"], create: ["recipientRef", "brief", "mode"], get: ["id"],
    result: ["id", "version", "text", "sources"], send: ["id", "version"], cancel: ["id"],
    share_answer: ["id", "resultVersion", "text"],
  };
  const required: Record<string, string[]> = {
    research: ["id", "version"], recipients: [], list: [], create: ["recipientRef", "brief", "mode"], get: ["id"],
    result: ["id", "version", "text", "sources"], send: ["id", "version"], cancel: ["id"],
    share_answer: ["id", "resultVersion", "text"],
  };
  for (const field of Object.keys(value)) {
    if (field !== "action" && !fields[value.action]!.includes(field)) {
      ctx.addIssue({ code: "custom", message: `Поле ${field} не относится к этому действию` });
    }
  }
  for (const field of required[value.action]!) {
    if (value[field as keyof typeof value] === undefined) {
      ctx.addIssue({ code: "custom", message: `Нужно поле ${field}` });
    }
  }
}

/** Internal persistence contract; never expose the result action to a chat model. */
export const errandInput = errandFields.superRefine(validateFields);
export const errandToolInput = z.union([
  errandFields.extend({action:z.enum(["recipients","list","create","get","send","cancel","share_answer"]),text:z.string().trim().min(1).max(3000).optional()}).superRefine(validateFields),
  z.object({action:z.literal("research"),id:z.uuid(),version:z.number().int().positive()}).strict(),
]);

export type ErrandInput = z.infer<typeof errandInput>;
