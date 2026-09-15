/**
 * Owner check shared by every authored-skill mutation.
 *
 * Export:
 * - `requireCurrentOwner`: the caller's role attribute is only a precondition; the owner role is
 *   re-read from `family_memberships` inside the mutation's transaction.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import type { FamilyCaller } from "../family-context.js";

export async function requireCurrentOwner(client: PoolClient, caller: FamilyCaller): Promise<void> {
  if (caller.role !== "owner") {
    throw new AppError("AGENT_SKILL_FORBIDDEN", "Создавать и менять навыки может только владелец семьи");
  }
  const owner = await client.query(
    `SELECT 1 FROM family_memberships
      WHERE family_id = $1 AND user_id = $2 AND role = 'owner' FOR SHARE`,
    [caller.familyId, caller.userId],
  );
  if (!owner.rowCount) {
    throw new AppError(
      "AGENT_SKILL_FORBIDDEN",
      "Права владельца больше не действуют. Обновите чат и повторите действие",
    );
  }
}
