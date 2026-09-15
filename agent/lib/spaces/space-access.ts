/** Space membership and conversation binding, independent of tool-specific capabilities. */
import type { PoolClient } from "pg";
import { AppError } from "../app-error.js";

export type SpaceKind = "personal" | "work" | "shared" | "group" | "legacy_family";
export type SpaceRole = "manager" | "adult" | "helper" | "child" | "external";
export type SpaceAction = "read" | "write" | "complete_own_task" | "propose_task" |
  "publish" | "manage_members" | "use_integrations";

/** All fields come from verified channel/session state, never a model's tool arguments. */
export interface SpaceContext {
  readonly familyId: string;
  readonly userId: string | null;
  readonly spaceId: string;
  readonly chat: { readonly type: "private" } |
    { readonly type: "group" | "supergroup"; readonly groupId: string };
}

export interface SpaceAccess {
  readonly spaceId: string;
  readonly kind: SpaceKind;
  readonly title: string;
  readonly policyVersion: number;
  readonly role: SpaceRole;
}

interface SpaceRow {
  id: string;
  kind: SpaceKind;
  title: string;
  policy_version: number;
  owner_user_id: string | null;
  source_group_id: string | null;
  state: string;
}

const permissions: Record<SpaceRole, readonly SpaceAction[]> = {
  manager: ["read", "write", "complete_own_task", "propose_task", "publish", "manage_members", "use_integrations"],
  adult: ["read", "write", "complete_own_task", "propose_task", "publish", "use_integrations"],
  helper: ["read", "write", "complete_own_task", "propose_task"],
  child: ["read", "complete_own_task", "propose_task"],
  external: ["read", "write", "complete_own_task", "propose_task"],
};

function denied(): never {
  throw new AppError("AGENT_SPACE_ACCESS_DENIED", "Нет доступа к этому пространству или действию");
}

/**
 * Caller must hold a transaction through the associated repository read/write. The shared parent
 * lock serializes it with membership/binding changes without locking a child before its parent.
 * This is the audience boundary; existing mode/capability and object-author checks still apply.
 */
export async function resolveSpaceAccess(client: PoolClient, context: SpaceContext): Promise<SpaceAccess> {
  const space = (await client.query<SpaceRow>(
    `SELECT id,kind,title,policy_version,owner_user_id,source_group_id,state
     FROM spaces WHERE family_id=$1 AND id=$2 FOR SHARE`, [context.familyId, context.spaceId],
  )).rows[0];
  if (!space || space.state !== "active") denied();

  let external = false;
  if (context.chat.type !== "private") {
    const binding = (await client.query<{ type: string }>(
      `SELECT g.type FROM space_bindings b JOIN telegram_groups g
         ON g.id=b.group_id AND g.family_id=b.family_id
       WHERE b.family_id=$1 AND b.group_id=$2 AND b.space_id=$3 AND b.state='active'`,
      [context.familyId, context.chat.groupId, context.spaceId],
    )).rows[0];
    if (!binding) denied();
    external = binding.type === "external";
    if (external ? space.kind !== "group" || space.source_group_id !== context.chat.groupId
      : binding.type !== "family_private" || !["shared", "legacy_family"].includes(space.kind)) denied();
  } else if (space.kind === "group") {
    // A future private cross-context reader must also prove current Telegram membership. A static
    // family membership or old space snapshot alone must not become that proof.
    denied();
  }

  let role: SpaceRole = "external";
  if (!external) {
    if (!context.userId || (space.owner_user_id !== null && space.owner_user_id !== context.userId)) denied();
    const member = (await client.query<{ role: SpaceRole }>(
      `SELECT m.role FROM space_memberships m JOIN family_memberships f
         ON f.family_id=m.family_id AND f.user_id=m.user_id
       WHERE m.family_id=$1 AND m.space_id=$2 AND m.user_id=$3 AND m.state='active'`,
      [context.familyId, context.spaceId, context.userId],
    )).rows[0];
    if (!member || !Object.hasOwn(permissions, member.role)) denied();
    role = member.role;
  }
  return { spaceId: space.id, kind: space.kind, title: space.title, policyVersion: space.policy_version, role };
}

/** Revalidate the live audience before every data operation and before a side effect. */
export async function authorizeSpaceAction(
  client: PoolClient,
  context: SpaceContext & { readonly policyVersion: number },
  action: SpaceAction,
): Promise<SpaceAccess> {
  const access = await resolveSpaceAccess(client, context);
  if (!permissions[access.role].includes(action)) denied();
  if (access.policyVersion !== context.policyVersion) {
    throw new AppError("AGENT_SPACE_CONTEXT_STALE", "Права пространства изменились. Нужен новый контекст разговора");
  }
  return access;
}

/**
 * Право на действие над **готовой строкой**, чья область не обязана совпадать с доказанной ходом.
 *
 * Личный чат читает все области своего человека, поэтому изменить он может и то, что пришло из
 * соседней своей области. Проверять там версию политики нечего: ход её не доказывал. Достаточно
 * живого членства и роли в самой области строки — их читает та же транзакция, и отзыв доступа
 * действует сразу.
 */
export async function authorizeRecordSpaceAction(
  client: PoolClient,
  context: SpaceContext,
  action: SpaceAction,
): Promise<SpaceAccess> {
  const access = await resolveSpaceAccess(client, context);
  if (!permissions[access.role].includes(action)) denied();
  return access;
}
