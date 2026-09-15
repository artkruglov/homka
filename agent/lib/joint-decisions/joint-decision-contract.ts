/** Joint proposals have immutable wording and independently authored consent and feedback. */
import { z } from "zod";
import { AppError } from "../app-error.js";

export type DecisionChoice = "agree" | "decline";
export type DecisionStatus = "open" | "agreed" | "declined" | "cancelled";
export interface DecisionAnswer { actor: string; choice: DecisionChoice }

/** Participants and answers must come from verified persistence, never from model input. */
export function decisionStatus(participants:readonly string[],answers:readonly DecisionAnswer[],cancelled:boolean):DecisionStatus {
  const actors=new Set(answers.map(answer=>answer.actor));
  if(participants.length!==2 || new Set(participants).size!==2 || participants.some(id=>!id)
    || actors.size!==answers.length || answers.some(answer=>!participants.includes(answer.actor)
      || !["agree","decline"].includes(answer.choice))) {
    throw new AppError("AGENT_DECISION_STATE_INVALID","Не удалось подтвердить участников и ответы решения");
  }
  if(cancelled)return "cancelled";
  if(answers.some(answer=>answer.choice==="decline"))return "declined";
  return answers.length===2 ? "agreed" : "open";
}

export const decisionInput=z.object({
  action:z.enum(["participants","list","create","get","answer","cancel","feedback","withdraw_feedback"]),
  id:z.uuid().optional(),
  partnerRef:z.uuid().optional(),
  title:z.string().trim().min(1).max(300).optional(),
  details:z.string().trim().min(1).max(2000).optional(),
  version:z.number().int().positive().optional(),
  choice:z.enum(["agree","decline"]).optional(),
  text:z.string().trim().min(1).max(2000).optional(),
}).strict().superRefine((value,ctx)=>{
  const allowed:Record<string,string[]>={participants:[],list:[],create:["partnerRef","title","details"],get:["id"],
    answer:["id","version","choice"],cancel:["id","version"],feedback:["id","version","text"],withdraw_feedback:["id","version"]};
  const required:Record<string,string[]>={...allowed,create:["partnerRef","title"]};
  for(const field of Object.keys(value))if(field!=="action"&&!allowed[value.action]!.includes(field))
    ctx.addIssue({code:"custom",message:`Поле ${field} не относится к этому действию`});
  for(const field of required[value.action]!)if(value[field as keyof typeof value]===undefined)
    ctx.addIssue({code:"custom",message:`Нужно поле ${field}`});
});
export type DecisionInput=z.infer<typeof decisionInput>;
