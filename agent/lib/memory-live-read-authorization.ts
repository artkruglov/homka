/**
 * Shared execution-time SQL authorization for model-facing memory reads.
 *
 * Export:
 * - `liveMemoryReadPredicate`: emits fail-closed membership and group-registration checks.
 */
import { spaceReadClause } from "./spaces/space-sql.js";

interface LiveMemoryReadPredicateInput {
  alias: string;
  spaceParameters?: { id: string; version: string };
  externalProjectionPredicate?: string;
  personalIdentityColumn: "owner_user_id" | "scope_partition_key";
}

export function liveMemoryReadPredicate(input: LiveMemoryReadPredicateInput): string {
  const record = input.alias;
  const currentMembership = `EXISTS (
    SELECT 1 FROM family_memberships AS live_memory_member
    WHERE live_memory_member.family_id = $1
      AND live_memory_member.user_id = $3
  )`;

  // Group type is read from the same current registration that proves the family/group identity.
  const currentGroupRegistration = `EXISTS (
    SELECT 1 FROM telegram_groups AS live_memory_group
    WHERE live_memory_group.id = $4
      AND live_memory_group.family_id = $1
      AND live_memory_group.id = ${record}.group_id
      AND (
        live_memory_group.type = 'external' OR
        (live_memory_group.type = 'family_private' AND ${currentMembership})
      )
  )`;

  // Private chats have no group identity; family-group turns must retain their exact registration.
  const currentFamilyContext = `(
    $4::uuid IS NULL OR EXISTS (
      SELECT 1 FROM telegram_groups AS live_family_group
      WHERE live_family_group.id = $4
        AND live_family_group.family_id = $1
        AND live_family_group.type = 'family_private'
    )
  )`;
  const projection = input.externalProjectionPredicate === undefined
    ? ""
    : ` OR ('personal' = ANY($2::memory_scope[])
      AND ${currentMembership}
      AND ${input.externalProjectionPredicate})`;

  const scopePredicate = `(
    (${record}.scope = 'personal' AND 'personal' = ANY($2::memory_scope[])
      AND ${record}.${input.personalIdentityColumn} = $3
      AND ${currentMembership}) OR
    (${record}.scope = 'family' AND 'family' = ANY($2::memory_scope[])
      AND ${currentMembership}
      AND ${currentFamilyContext}) OR
    (${record}.scope = 'group' AND 'group' = ANY($2::memory_scope[])
      AND ${record}.group_id = $4
      AND ${currentGroupRegistration})
    ${projection}
  )`;
  const space = input.spaceParameters;
  if (!space) return scopePredicate;
  // Этот предикат исторически держит семью, человека и группу в $1, $3 и $4; общий строитель
  // принимает позиции аргументом, поэтому им могут пользоваться и непамятные репозитории.
  const spacePredicate = spaceReadClause({
    alias: record,
    parameters: { family: "$1", group: "$4", spaceId: space.id, user: "$3", version: space.version },
  });
  return `(${scopePredicate} AND ${spacePredicate})`;
}
