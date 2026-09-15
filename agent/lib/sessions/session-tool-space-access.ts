/** Live membership fence at the shared tool boundary; repository authorization still owns data scope. */
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { readFamilySpaceMode } from "../spaces/family-space-mode.js";
import { authorizeSpaceAction } from "../spaces/space-access.js";

const uuid = z.string().uuid();
function invalid(): never {
  throw new AppError("AGENT_TOOL_SPACE_CONTEXT_INVALID", "Контекст пространства больше не подтверждён. Начните новый диалог");
}

/** Пока режим семьи прежний, ход без области идёт как раньше; после включения это забытый путь. */
async function requireLegacyModeAllowed(familyId: unknown): Promise<void> {
  const family = uuid.safeParse(familyId);
  if (!family.success) return;
  const client = await database().connect();
  try {
    if (await readFamilySpaceMode(client, family.data) === "spaces") invalid();
  } finally {
    client.release();
  }
}

export async function requireToolSpaceAccess(ctx: Pick<ToolContext, "session">): Promise<void> {
  const auth = ctx.session?.auth?.current;
  const attrs = auth?.attributes;
  if (attrs?.spaceId === undefined && attrs?.spacePolicyVersion === undefined) {
    return await requireLegacyModeAllowed(attrs?.familyId);
  }
  if (!auth || !attrs) invalid();
  const spaceId = uuid.safeParse(attrs.spaceId);
  const familyId = uuid.safeParse(attrs.familyId);
  const sessionId = uuid.safeParse(attrs.applicationSessionId);
  const version = typeof attrs.spacePolicyVersion === "string" ? Number(attrs.spacePolicyVersion) : NaN;
  if (!spaceId.success || !familyId.success || !sessionId.success || !Number.isSafeInteger(version) || version < 1
    || String(version) !== attrs.spacePolicyVersion) invalid();
  const type = attrs.telegramChatType;
  if (type !== "private" && type !== "group" && type !== "supergroup") invalid();
  const group = uuid.safeParse(attrs.groupId);
  if (type !== "private" && !group.success) invalid();
  const principal = auth.principalType === "user" ? uuid.safeParse(auth.principalId) : null;
  const userId = principal?.success ? principal.data : null;
  const groupId = type === "private" ? null : group.data!;
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await authorizeSpaceAction(client, {
      familyId: familyId.data, spaceId: spaceId.data, userId, policyVersion: version,
      chat: type === "private" ? { type } : { type, groupId: groupId! },
    }, "read");
    // Lock parent first, then the persisted application session. Children inherit its verified ID.
    const session = await client.query(
      `SELECT id FROM conversation_sessions WHERE id=$1 AND family_id=$2 AND space_id=$3
         AND space_policy_version=$4 AND retired_at IS NULL
         AND group_id IS NOT DISTINCT FROM $5::uuid
         AND ($5::uuid IS NOT NULL OR owner_user_id=$6::uuid) FOR SHARE`,
      [sessionId.data,familyId.data,spaceId.data,version,groupId,userId],
    );
    if (session.rowCount !== 1) invalid();
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
