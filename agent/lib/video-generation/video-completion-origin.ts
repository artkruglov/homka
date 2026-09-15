/** Private backend snapshot, never a model-facing input and never sufficient authorization.
 * Decode persisted data before fresh membership, scope, workspace and destination checks.
 */
import {z} from 'zod';
import {AppError} from '../app-error.js';
const schema=z.object({
  version:z.literal(1),workspaceId:z.string().uuid(),actorTelegramId:z.string().regex(/^[1-9][0-9]{0,18}$/u),
  scope:z.enum(['personal','family','group']),
  forumTopicId:z.string().regex(/^[1-9][0-9]*$/u).nullable().optional(),
  target:z.object({chatId:z.string().regex(/^-?[1-9][0-9]{0,18}$/u),
    messageThreadId:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()}).strict(),
  authorization:z.object({familyId:z.string().uuid(),userId:z.string().uuid().nullable(),
    groupId:z.string().uuid().nullable(),groupType:z.enum(['external','family_private']).nullable(),
    role:z.enum(['external','member','owner','recovery_owner']),telegramChatType:z.enum(['private','group','supergroup']),
    space:z.object({spaceId:z.string().uuid(),policyVersion:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}).strict().optional(),
  }).strict(),
}).strict().superRefine((origin,ctx)=>{
  const auth=origin.authorization;
  const personal=origin.scope==='personal'&&auth.telegramChatType==='private'&&auth.userId!==null&&
    auth.role!=='external'&&auth.groupId===null&&auth.groupType===null&&
    origin.target.chatId===origin.actorTelegramId&&origin.target.messageThreadId===undefined;
  const group=auth.telegramChatType!=='private'&&auth.groupId!==null&&origin.target.chatId.startsWith('-')&&
    ((origin.scope==='family'&&auth.groupType==='family_private'&&auth.userId!==null&&auth.role!=='external')||
      (origin.scope==='group'&&auth.groupType==='external'));
  if((origin.forumTopicId!=null&&(origin.scope==='personal'||origin.forumTopicId!==origin.target.messageThreadId?.toString()))||!(personal||group)||((auth.role==='external')!==(auth.userId===null))){
    ctx.addIssue({code:'custom',message:'Origin boundary mismatch'});
  }
});
export type VideoCompletionOrigin=z.infer<typeof schema>;
export function parseVideoCompletionOrigin(value:unknown):VideoCompletionOrigin{
  const parsed=schema.safeParse(value);
  if(!parsed.success)throw new AppError('AGENT_VIDEO_COMPLETION_ORIGIN_INVALID','Исходный контекст видеозадания не подтверждён');
  return parsed.data;
}
export function videoOriginTargetKey(origin:VideoCompletionOrigin):string{
  return `${origin.target.chatId}:${origin.target.messageThreadId??0}`;
}
