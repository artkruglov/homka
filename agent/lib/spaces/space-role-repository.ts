/** Live owner authority and parent-first locks for narrowing an existing space membership. */
import type { PoolClient } from "pg";
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { authorize,participants } from "../shared-task-access.js";
import { authorizeRecordSpaceAction,type SpaceRole } from "./space-access.js";

interface Member { memberRef:string; name:string; role:SpaceRole }
export interface SpaceRoleSnapshot { areaRef:string; title:string; policyVersion:number; members:Member[] }
export interface AssignSpaceRole { areaRef:string; memberRef:string; role:"helper"|"child"; policyVersion:number }
const denied=()=>new AppError("AGENT_SPACE_MEMBER_UNAVAILABLE","Участник или пространство больше недоступны");

async function ownerSpace(client:PoolClient,auth:MemoryAuthorization,spaceId:string) {
  const row=(await client.query<{title:string;policy_version:number}>(
    "SELECT title,policy_version FROM spaces WHERE id=$1 AND family_id=$2 AND state='active' FOR UPDATE",[spaceId,auth.familyId])).rows[0];
  if(!row) throw denied();
  await authorize(client,auth);
  const owner=(await client.query("SELECT 1 FROM family_memberships WHERE family_id=$1 AND user_id=$2 AND role='owner' FOR SHARE",[auth.familyId,auth.userId])).rowCount;
  if(!owner) throw new AppError("AGENT_OWNER_REQUIRED","Назначать роли может только действующий владелец семьи");
  await authorizeRecordSpaceAction(client,{familyId:auth.familyId,userId:auth.userId,spaceId,
    chat:auth.groupId?{type:"group",groupId:auth.groupId}:{type:"private"}},"manage_members");
  return row;
}

async function memberRows(client:PoolClient,auth:MemoryAuthorization,spaceId:string) {
  await participants(client,auth,"family");
  return (await client.query<{member_ref:string;name:string;role:SpaceRole;user_id:string}>(
    `SELECT p.id AS member_ref,u.display_name AS name,m.role,u.id AS user_id
      FROM space_memberships m JOIN users u ON u.id=m.user_id
      JOIN family_memberships f ON f.family_id=m.family_id AND f.user_id=m.user_id
      JOIN shared_task_participants p ON p.family_id=m.family_id AND p.group_id IS NULL AND p.telegram_user_id=u.telegram_user_id
      WHERE m.family_id=$1 AND m.space_id=$2 AND m.state='active' ORDER BY u.display_name,u.id`,[auth.familyId,spaceId])).rows;
}

async function snapshot(client:PoolClient,auth:MemoryAuthorization,areaRef:string):Promise<SpaceRoleSnapshot> {
  const row=await ownerSpace(client,auth,areaRef);
  return {areaRef,title:row.title,policyVersion:row.policy_version,
    members:(await memberRows(client,auth,areaRef)).map(m=>({memberRef:m.member_ref,name:m.name,role:m.role}))};
}

export const spaceRoleRepository={
  async members(auth:MemoryAuthorization,areaRef:string):Promise<SpaceRoleSnapshot> {
    const client=await database().connect();
    try {await client.query("BEGIN");const result=await snapshot(client,auth,areaRef);await client.query("COMMIT");return result;}
    catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  },
  async assign(auth:MemoryAuthorization,input:AssignSpaceRole):Promise<SpaceRoleSnapshot> {
    if(!["helper","child"].includes(input.role)) throw new AppError("AGENT_SPACE_ROLE_INVALID","Выберите роль helper или child");
    const client=await database().connect();
    try {
      await client.query("BEGIN");
      const space=await ownerSpace(client,auth,input.areaRef);
      const target=(await memberRows(client,auth,input.areaRef)).find(m=>m.member_ref===input.memberRef);
      if(!target) throw denied();
      if(target.role!==input.role) {
        if(space.policy_version!==input.policyVersion) throw new AppError("AGENT_SPACE_CONTEXT_STALE","Права пространства изменились. Прочитайте участников и подтвердите изменение заново");
        if(target.role==="child"&&input.role==="helper") throw new AppError("AGENT_SPACE_ROLE_NEW_SPACE_REQUIRED","Расширение прав требует нового пространства");
        await client.query("UPDATE space_memberships SET role=$3 WHERE space_id=$1 AND user_id=$2",[input.areaRef,target.user_id,input.role]);
        await client.query(`INSERT INTO audit_events(family_id,actor_user_id,event_type,subject_id,metadata)
          VALUES($1,$2,'space.member_role_changed',$3,$4)`,[auth.familyId,auth.userId,input.areaRef,
          {memberRef:input.memberRef,previousRole:target.role,role:input.role}]);
      }
      const result=await snapshot(client,auth,input.areaRef);
      await client.query("COMMIT");return result;
    }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  },
};
