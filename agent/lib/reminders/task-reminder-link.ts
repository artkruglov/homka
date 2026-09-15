/** Personal signals for accepted work or the author's unanswered request; purpose stays fixed. */
import type { PoolClient } from "pg";
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { isCurrentTelegramMember } from "../telegram-current-membership.js";
import type { ReminderAuthorization } from "./reminder-context.js";

export type TaskReminderKind = 'execution' | 'response';

/** The personal delivery destination does not grant access to the source task. */
function taskSourceReadable():string {
  return `((t.space_id IS NULL AND NOT EXISTS(SELECT 1 FROM family_space_runtime runtime
    WHERE runtime.family_id=t.family_id AND runtime.mode='spaces')) OR EXISTS(
    SELECT 1 FROM spaces source_space WHERE source_space.id=t.space_id
      AND source_space.family_id=t.family_id AND source_space.state='active'
      AND (source_space.kind='group' OR EXISTS(SELECT 1 FROM space_memberships member
        WHERE member.space_id=source_space.id AND member.family_id=t.family_id
          AND member.user_id=u.id AND member.state='active'))))`;
}

/** Only static application aliases are accepted; no model or user text enters SQL. */
export function linkedTaskActive(alias:'r'|'reminder'|'reminders'):string {
  return `EXISTS (SELECT 1 FROM shared_tasks t JOIN users u ON u.id=${alias}.author_user_id
    WHERE t.id=${alias}.shared_task_id AND t.family_id=${alias}.family_id AND ${taskSourceReadable()} AND (
      (${alias}.task_reminder_kind='execution' AND t.status='accepted' AND t.assignee_telegram_id=u.telegram_user_id)
      OR (${alias}.task_reminder_kind='response' AND t.status='proposed' AND t.creator_telegram_id=u.telegram_user_id)))`;
}

export async function requireTaskReminderLink(client:PoolClient,auth:ReminderAuthorization,id:string,content?:string,lock=true,expectedKind?:TaskReminderKind) {
  const result=await client.query<{title:string;group_id:string|null;telegram_chat_id:string|null;telegram_user_id:string;link_kind:TaskReminderKind}>(
    `SELECT t.title,t.group_id,g.telegram_chat_id,u.telegram_user_id,
      CASE WHEN t.status='proposed' THEN 'response' ELSE 'execution' END AS link_kind FROM shared_tasks t
      JOIN users u ON u.id=$3
      JOIN family_memberships m ON m.user_id=u.id AND m.family_id=t.family_id
      LEFT JOIN telegram_groups g ON g.id=t.group_id
      WHERE t.id=$1 AND t.family_id=$2 AND ${taskSourceReadable()} AND (
        (t.status='accepted' AND t.kind IN ('task','ritual') AND u.telegram_user_id=t.assignee_telegram_id)
        OR (t.status='proposed' AND t.kind='task' AND u.telegram_user_id=t.creator_telegram_id))
        AND (t.group_id IS NULL OR (g.type='external' AND 'manage_shared_tasks'=ANY(g.tool_allowlist)))
      ${lock ? 'FOR SHARE OF t' : ''}`,[id,auth.familyId,auth.userId]);
  const row=result.rows[0];
  if (auth.telegramChatType !== 'private' || !row || expectedKind !== undefined && row.link_kind !== expectedKind || content !== undefined && content !== row.title ||
    row.group_id && (!row.telegram_chat_id || !await isCurrentTelegramMember(row.telegram_chat_id,row.telegram_user_id))) {
    throw new AppError('AGENT_TASK_REMINDER_DENIED','В личке можно напомнить о своём принятом деле/традиции или проверить ответ на свою просьбу proposed; текст должен совпадать с названием');
  }
  return row.link_kind;
}

export async function checkLinkedReminderBeforeDispatch(id:string,leaseToken:string) {
  const client=await database().connect();
  try {
    const result=await client.query<{shared_task_id:string|null;task_reminder_kind:TaskReminderKind;content:string;family_id:string;author_user_id:string;telegram_chat_id:string}>(
      "SELECT shared_task_id,task_reminder_kind,content,family_id,author_user_id,telegram_chat_id FROM reminders WHERE id=$1 AND status='leased' AND lease_token=$2",[id,leaseToken]);
    const row=result.rows[0];
    if (!row?.shared_task_id) return;
    await requireTaskReminderLink(client,{familyId:row.family_id,userId:row.author_user_id,telegramChatType:'private',
      telegramChatId:row.telegram_chat_id,groupId:null,groupType:null,role:'member',forumTopicId:null,messageThreadId:null},row.shared_task_id,undefined,false,row.task_reminder_kind);
  } finally {client.release();}
}
