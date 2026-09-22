/** A new proposal publishes only to a proven shared audience, never an inferred private-chat family. */
import type { PoolClient } from "pg";
import { AppError } from "../app-error.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { authorize,participants } from "../shared-task-access.js";
import { requireSpaceAction } from "../spaces/space-write.js";

function sharedRequired():never {
  throw new AppError("AGENT_DECISION_SHARED_SPACE_REQUIRED","Выберите общую область или семейный чат для совместного решения");
}

/**
 * Caller holds a transaction. The space is locked before family membership and directory rows.
 *
 * `allowPersonal` значит «человек отвечает у себя в личке»: уведомление о решении приходит именно
 * туда, и требовать переключения в общую область ради ответа — верный способ не получить ответа.
 * Создание предложения по-прежнему требует доказанной общей аудитории.
 */
export async function decisionAudience(
  client:PoolClient,auth:MemoryAuthorization,create=false,allowPersonal=false,
) {
  if(!auth.userId || auth.role==="external")sharedRequired();
  if(!auth.groupId&&!auth.space){
    if(!allowPersonal||auth.telegramActorKind!=="telegram_user")sharedRequired();
    await participants(client,auth,"family");
    const rows=(await client.query<{id:string;display_name:string}>(
      `SELECT p.id,u.display_name FROM shared_task_participants p
        JOIN users u ON u.telegram_user_id=p.telegram_user_id
        JOIN family_memberships m ON m.user_id=u.id AND m.family_id=p.family_id
        WHERE p.family_id=$1 AND p.group_id IS NULL ORDER BY u.display_name,p.id LIMIT 100`,
      [auth.familyId])).rows;
    return {personalAnswer:true as const,spaceId:null,
      participants:rows.map(row=>({participantRef:row.id,name:row.display_name}))};
  }
  const spaceId=await requireSpaceAction(client,{familyId:auth.familyId,userId:auth.userId,groupId:auth.groupId,
    chatType:auth.groupId?"supergroup":"private",...(auth.space?{space:auth.space}:{})},create?"write":"read");
  if(spaceId){
    const row=(await client.query<{kind:string}>("SELECT kind FROM spaces WHERE id=$1 AND family_id=$2",[spaceId,auth.familyId])).rows[0];
    if(row?.kind!=="shared")sharedRequired();
  }
  const scope=await authorize(client,auth);
  if(scope==="group")sharedRequired();
  await participants(client,auth,"family");
  const result=await client.query<{id:string;display_name:string}>(
    `SELECT p.id,u.display_name FROM shared_task_participants p
      JOIN users u ON u.telegram_user_id=p.telegram_user_id
      JOIN family_memberships m ON m.user_id=u.id AND m.family_id=p.family_id
      WHERE p.family_id=$1 AND p.group_id IS NULL AND ($2::uuid IS NULL OR EXISTS(
        SELECT 1 FROM space_memberships sm WHERE sm.family_id=p.family_id
          AND sm.space_id=$2 AND sm.user_id=u.id AND sm.state='active'))
      ORDER BY u.display_name,p.id LIMIT 100`,[auth.familyId,spaceId]);
  return {personalAnswer:false as const,spaceId,
    participants:result.rows.map(row=>({participantRef:row.id,name:row.display_name}))};
}
