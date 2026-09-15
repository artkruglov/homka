/**
 * Authorized filesystem-first workspace repository.
 *
 * Exports:
 * - `WorkspaceAuthorization`, file metadata, and scope types: public contracts.
 * - `createWorkspaceRepository`: direct filesystem operations behind current access checks.
 * - `workspaceRepository`: production repository rooted at `/app/workspaces`.
 * - `externalGroupRoot`: resolves a group root at the final live authorization boundary.
 * - `trustedRoots`: resolves current personal/family host roots for delegated file wrappers.
 */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { readFamilySpaceMode } from "../spaces/family-space-mode.js";
import type { SpaceAttributes } from "../spaces/space-attributes.js";
import {
  type WorkspaceFileRecord,
  type WorkspaceScope,
} from "./workspace-file-record.js";
import { validateWorkspacePath } from "./workspace-path.js";
import {
  deleteWorkspaceFile,
} from "./workspace-storage.js";

export type {
  WorkspaceFileRecord,
  WorkspaceScope,
} from "./workspace-file-record.js";

export interface WorkspaceAuthorization {
  /** Область, доказанная ходом. Её отсутствие означает прежний режим семьи и проверяется в БД. */
  space?: SpaceAttributes;
  familyId: string;
  groupId: string | null;
  groupType: "external" | "family_private" | null;
  role: "external" | "member" | "owner" | "recovery_owner";
  telegramChatType: "group" | "private" | "supergroup";
  userId: string | null;
}

interface WorkspaceRow {
  id: string;
  scope: WorkspaceScope;
}

async function assertCurrentAccess(
  client: PoolClient,
  auth: WorkspaceAuthorization,
  scope: WorkspaceScope,
): Promise<void> {
  if (scope === "personal") {
    if (auth.telegramChatType !== "private" || !auth.userId) {
      throw new AppError("AGENT_WORKSPACE_ACCESS_DENIED", "Личный workspace доступен только в личном чате");
    }
  } else if (scope === "family") {
    if (!auth.userId || auth.role === "external") {
      throw new AppError("AGENT_WORKSPACE_ACCESS_DENIED", "Семейный workspace доступен только участникам семьи");
    }
    if (auth.groupId) {
      const group = await client.query(
        `SELECT 1 FROM telegram_groups
          WHERE id = $1 AND family_id = $2 AND type = 'family_private'`,
        [auth.groupId, auth.familyId],
      );
      if (group.rowCount !== 1) {
        throw new AppError("AGENT_WORKSPACE_ACCESS_DENIED", "Этот чат не имеет доступа к семейному workspace");
      }
    }
  } else {
    if (!auth.groupId || auth.telegramChatType === "private") {
      throw new AppError("AGENT_WORKSPACE_ACCESS_DENIED", "Групповой workspace доступен только в своей группе");
    }
    const group = await client.query(
       `SELECT 1 FROM telegram_groups
        WHERE id = $1 AND family_id = $2 AND type = 'external'
        FOR SHARE`,
      [auth.groupId, auth.familyId],
    );
    if (group.rowCount !== 1) {
      throw new AppError("AGENT_WORKSPACE_ACCESS_DENIED", "Группа не имеет собственного workspace");
    }
    return;
  }

  // Personal and family access is recalculated from current membership on every operation.
  const membership = await client.query(
    "SELECT 1 FROM family_memberships WHERE family_id = $1 AND user_id = $2",
    [auth.familyId, auth.userId],
  );
  if (membership.rowCount !== 1) {
    throw new AppError("AGENT_WORKSPACE_ACCESS_REVOKED", "Доступ к workspace был отозван");
  }
}

async function resolveWorkspace(
  client: PoolClient,
  auth: WorkspaceAuthorization,
  scope: WorkspaceScope,
): Promise<WorkspaceRow> {
  await assertCurrentAccess(client, auth, scope);
  if (!auth.space) {
    // A migration can bind the old root before the family enables spaces. Its physical
    // identity must survive that binding. Newly authored spaces are never legacy roots.
    // Existing null-space duplicates stay selected until an operator reconciles their
    // files and receipts: silently preferring the older root would hide newer uploads.
    const existing = await client.query<WorkspaceRow>(
      `SELECT w.id, w.scope FROM workspaces w
       LEFT JOIN spaces s ON s.id = w.space_id AND s.family_id = w.family_id
       WHERE w.family_id = $1 AND w.scope = $4
         AND w.owner_user_id IS NOT DISTINCT FROM $2::uuid
         AND w.group_id IS NOT DISTINCT FROM $3::uuid
         AND (w.space_id IS NULL OR (
           s.legacy_scope::text = w.scope::text
           AND s.owner_user_id IS NOT DISTINCT FROM w.owner_user_id
           AND s.source_group_id IS NOT DISTINCT FROM w.group_id
         ))
       ORDER BY (w.space_id IS NULL) DESC LIMIT 1`,
      [auth.familyId, scope === "personal" ? auth.userId : null,
        scope === "group" ? auth.groupId : null, scope],
    );
    if (existing.rows[0]) return existing.rows[0];
  }
  const result = await client.query<WorkspaceRow>(
    `INSERT INTO workspaces (family_id, owner_user_id, group_id, scope, space_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (family_id, scope, owner_user_id, group_id, space_id) DO UPDATE
       SET family_id = EXCLUDED.family_id
     RETURNING id, scope`,
    [
      auth.familyId,
      scope === "personal" ? auth.userId : null,
      scope === "group" ? auth.groupId : null,
      scope,
      auth.space?.spaceId ?? null,
    ],
  );
  return result.rows[0]!;
}

/**
 * Ход видит ровно одну область, поэтому и корней у него ровно один. Прежде личный чат монтировал
 * рядом с личным ещё и семейный корень: под нативным `bash` это вторая область в одном ходе, а
 * обёртки инструментов перекрывают встроенные Eve только во внешних группах.
 *
 * Пока режим семьи прежний, набор корней остаётся прежним; после включения ход без области — это
 * забытый путь, и он обязан упасть громко, а не молча открыть корень чужой аудитории.
 */
async function workspaceScopes(
  client: PoolClient,
  auth: WorkspaceAuthorization,
): Promise<WorkspaceScope[]> {
  const legacy = auth.telegramChatType === "private"
    ? ["personal" as const, "family" as const]
    : auth.groupType === "family_private"
    ? ["family" as const]
    : auth.groupType === "external"
    ? ["group" as const]
    : [];
  if (legacy.length === 0) {
    throw new AppError("AGENT_WORKSPACE_CONTEXT_INVALID", "Для текущего чата не определён workspace");
  }
  if (!auth.space) {
    if (await readFamilySpaceMode(client, auth.familyId) === "spaces") {
      throw new AppError("AGENT_SPACE_CONTEXT_REQUIRED", "Область разговора не подтверждена. Начните новый диалог");
    }
    return legacy;
  }
  return [legacy[0]!];
}

async function previousOperation<T>(client: PoolClient, operationKey: string): Promise<T | null> {
  const result = await client.query<{ result: T }>(
    "SELECT result FROM workspace_operations WHERE operation_key = $1",
    [operationKey],
  );
  return result.rows[0]?.result ?? null;
}

async function saveOperation(
  client: PoolClient,
  operationKey: string,
  workspaceId: string,
  type: string,
  result: unknown,
): Promise<void> {
  await client.query(
    `INSERT INTO workspace_operations (operation_key, workspace_id, operation_type, result)
     VALUES ($1, $2, $3, $4)`,
    [operationKey, workspaceId, type, JSON.stringify(result)],
  );
}

export function createWorkspaceRepository(root: string) {
  return {
    async externalGroupRoot(auth: WorkspaceAuthorization): Promise<string> {
      // A family member keeps their administrative role inside an external group. Workspace access
      // follows the external trust zone and exact live group registration, not that family role.
      if (
        auth.groupType !== "external" ||
        auth.telegramChatType === "private"
      ) {
        throw new AppError(
          "AGENT_WORKSPACE_ACCESS_DENIED",
          "Групповой workspace доступен только в своей внешней группе",
        );
      }

      // Resolve against current PostgreSQL state on every file operation. Creating the directory
      // here makes host-side path inspection available before Eve lazily starts the sandbox.
      const client = await database().connect();
      try {
        await client.query("BEGIN");
        // Тот же гейт, что и у набора монтирований: без него ход без области после включения
        // завёл бы рядом второй корень с пустой областью, и файлы группы «исчезли» бы.
        await workspaceScopes(client, auth);
        const workspace = await resolveWorkspace(client, auth, "group");
        const hostRoot = resolve(root, workspace.id);
        await mkdir(hostRoot, { recursive: true });
        await client.query("COMMIT");
        return hostRoot;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async mounts(auth: WorkspaceAuthorization): Promise<Array<{
      mountPoint: WorkspaceScope;
      workspaceId: string;
    }>> {
      const client = await database().connect();
      try {
        const scopes = await workspaceScopes(client, auth);
        const mounts = [];
        for (const scope of scopes) {
          const workspace = await resolveWorkspace(client, auth, scope);
          mounts.push({ mountPoint: scope, workspaceId: workspace.id });
        }
        return mounts;
      } finally {
        client.release();
      }
    },

    async trustedRoots(auth: WorkspaceAuthorization): Promise<Array<{
      hostRoot: string;
      mountPoint: "family" | "personal";
    }>> {
      // Resolve membership again for every wrapped file call before exposing its host-side root.
      const client = await database().connect();
      try {
        const scopes = await workspaceScopes(client, auth);
        if (scopes.includes("group")) {
          throw new AppError(
            "AGENT_WORKSPACE_ACCESS_DENIED",
            "Task worker доступен только для личного или семейного workspace",
          );
        }
        const roots = [];
        for (const scope of scopes) {
          const workspace = await resolveWorkspace(client, auth, scope);
          const hostRoot = resolve(root, workspace.id);
          await mkdir(hostRoot, { recursive: true });
          roots.push({ hostRoot, mountPoint: scope as "family" | "personal" });
        }
        return roots;
      } finally {
        client.release();
      }
    },

    async deleteFile(
      auth: WorkspaceAuthorization,
      scope: WorkspaceScope,
      path: string,
      operationKey: string,
    ): Promise<{ deleted: boolean }> {
      const safePath = validateWorkspacePath(path);
      const client = await database().connect();
      try {
        await client.query("BEGIN");
        const replay = await previousOperation<{ deleted: boolean }>(client, operationKey);
        if (replay) {
          await client.query("COMMIT");
          return replay;
        }
        const workspace = await resolveWorkspace(client, auth, scope);
        const result = { deleted: await deleteWorkspaceFile(root, workspace.id, safePath) };
        await saveOperation(client, operationKey, workspace.id, "delete", result);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

export const workspaceRepository = createWorkspaceRepository(resolve("workspaces"));
