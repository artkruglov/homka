/** Exact action fields prevent a displayed role change from carrying hidden secondary actions. */
import { z } from "zod";
export const manageSpaceInput=z.object({
  action:z.enum(["status","switch","members","set_role"]),
  areaRef:z.uuid().optional(),memberRef:z.uuid().optional(),
  role:z.enum(["helper","child"]).optional(),policyVersion:z.number().int().positive().optional(),
}).strict().superRefine((value,ctx)=>{
  const required={status:[],switch:["areaRef"],members:["areaRef"],set_role:["areaRef","memberRef","role","policyVersion"]};
  const fields=required[value.action] as string[];
  for(const key of Object.keys(value)) if(key!=="action"&&!fields.includes(key)) ctx.addIssue({code:"custom",message:`Поле ${key} не относится к действию`});
  for(const key of fields) if(value[key as keyof typeof value]===undefined) ctx.addIssue({code:"custom",message:`Нужно поле ${key}`});
});
