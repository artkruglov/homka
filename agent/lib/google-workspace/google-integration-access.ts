/**
 * Live PostgreSQL authorization for Google Workspace profile operations.
 *
 * Exports:
 * - `GoogleWorkspaceActor`: trusted workspace identity required by repository checks.
 * - `assertGoogleWorkspaceAccess`: validates current personal/family access and management role.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import type { FamilyRole } from "../family-access.js";
import type { GoogleIntegrationAuthorization } from "./google-integration-contract.js";
import { authorizeRecordSpaceAction } from "../spaces/space-access.js";
import { readFamilySpaceMode } from "../spaces/family-space-mode.js";

export type GoogleWorkspaceActor = Pick<
  GoogleIntegrationAuthorization,
  "familyId" | "scope" | "userId" | "workspaceId"
>;

export async function assertGoogleWorkspaceAccess(
  client: PoolClient,
  auth: GoogleWorkspaceActor,
  management: boolean,
): Promise<void> {
  const boundary=(await client.query<{space_id:string|null}>(
    "SELECT space_id FROM workspaces WHERE id=$1 AND family_id=$2",[auth.workspaceId,auth.familyId])).rows[0];
  if(boundary?.space_id) await authorizeRecordSpaceAction(client,{familyId:auth.familyId,userId:auth.userId,
    spaceId:boundary.space_id,chat:{type:"private"}},"use_integrations");
  else if(await readFamilySpaceMode(client,auth.familyId)==="spaces")
    throw new AppError("AGENT_SPACE_CONTEXT_REQUIRED","Область подключения не подтверждена");
  // Membership and workspace ownership are read live in the same DB boundary as the operation.
  const result = await client.query<{
    owner_user_id: string | null;
    role: FamilyRole;
    scope: "family" | "personal";
    space_id:string|null;
  }>(
    `SELECT workspace.owner_user_id, workspace.scope, workspace.space_id, membership.role
     FROM workspaces AS workspace
     JOIN family_memberships AS membership
       ON membership.family_id = workspace.family_id AND membership.user_id = $2
     WHERE workspace.id = $1 AND workspace.family_id = $3
       AND workspace.scope IN ('personal', 'family')
     FOR SHARE OF workspace, membership`,
    [auth.workspaceId, auth.userId, auth.familyId],
  );
  const workspace = result.rows[0];
  const personal = workspace?.scope === "personal" && workspace.owner_user_id === auth.userId;
  const family = workspace?.scope === "family";
  if (!workspace || workspace.space_id !== boundary?.space_id || workspace.scope !== auth.scope || (!personal && !family)) {
    throw new AppError(
      "AGENT_GOOGLE_WORKSPACE_ACCESS_DENIED",
      "У вас нет доступа к этому профилю Google Workspace",
    );
  }
  if (management && family && workspace.role !== "owner") {
    throw new AppError(
      "AGENT_OWNER_REQUIRED",
      "Подключать и отключать общий Google Workspace может только владелец семьи",
    );
  }
}
