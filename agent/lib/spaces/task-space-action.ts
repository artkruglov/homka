/** Space role checks narrow task operations; they never replace identity-based task visibility. */
import type { PoolClient } from "pg";
import type { MemoryAuthorization } from "../memory-context.js";
import type { SharedTaskInput } from "../shared-tasks.js";
import { AppError } from "../app-error.js";
import { authorizeRecordSpaceAction,type SpaceAction } from "./space-access.js";
import { readFamilySpaceMode } from "./family-space-mode.js";

export function taskSpaceAction(input:SharedTaskInput):SpaceAction {
  if(["list","lists","participants","history"].includes(input.action)) return "read";
  if(input.action==="create" && (!input.kind || input.kind==="task")) return "propose_task";
  if(["complete","accept","decline","accept_transfer","decline_transfer"].includes(input.action)) return "complete_own_task";
  return "write";
}

/** Lock only the parent boundary before any family membership or task-row lock. No data is returned. */
export async function lockTaskSpaceBoundary(client:PoolClient,familyId:string,id:string) {
  await client.query(`SELECT s.id FROM spaces s JOIN shared_tasks t ON t.space_id=s.id AND t.family_id=s.family_id
    WHERE t.family_id=$1 AND t.id=$2 FOR SHARE OF s`,[familyId,id]);
}

/** Call after readTasks proves identity and live group access, before locking the task row. */
export async function requireTaskRecordAction(client:PoolClient,auth:MemoryAuthorization,id:string,action:SpaceAction) {
  const row=(await client.query<{space_id:string|null;group_id:string|null;version:number}>(
    "SELECT space_id,group_id,version FROM shared_tasks WHERE id=$1 AND family_id=$2",[id,auth.familyId])).rows[0];
  if(!row) throw new AppError("AGENT_TASK_ACCESS_DENIED","Задача недоступна");
  const groupId=auth.groupId ?? row.group_id;
  if(row.space_id) await authorizeRecordSpaceAction(client,{familyId:auth.familyId,userId:auth.userId,spaceId:row.space_id,
    chat:groupId?{type:"group",groupId}:{type:"private"}},action);
  else if(await readFamilySpaceMode(client,auth.familyId)==="spaces") throw new AppError("AGENT_SPACE_CONTEXT_REQUIRED","Область задачи не подтверждена");
  return row.version;
}

/** A family membership or old participant ref is not membership of the task's audience. */
export async function requireTaskRecipientSpace(client:PoolClient,auth:MemoryAuthorization,spaceId:string|null,recipient:string|null) {
  if(!spaceId || !recipient) return;
  const result=await client.query(`SELECT s.id FROM spaces s
    WHERE s.id=$1 AND s.family_id=$2 AND s.state='active' AND
      (s.kind='group' OR EXISTS(SELECT 1 FROM space_memberships m JOIN users u ON u.id=m.user_id
        JOIN family_memberships f ON f.family_id=m.family_id AND f.user_id=m.user_id
        WHERE m.space_id=s.id AND m.family_id=s.family_id AND m.state='active' AND u.telegram_user_id=$3))`,
    [spaceId,auth.familyId,recipient]);
  if(!result.rowCount) throw new AppError("AGENT_TASK_ACCESS_DENIED","Участнику недоступна область задачи");
}
