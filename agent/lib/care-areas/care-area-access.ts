/** Shared care-area audience clause for listing, mutations and task links. */
import type { MemoryAuthorization } from "../memory-context.js";
import { spaceReadClause } from "../spaces/space-sql.js";

export const CARE_AREA_VISIBILITY = spaceReadClause({
  alias: "area",
  parameters: { family: "$2", group: "$8", spaceId: "$5", version: "$6", user: "$7" },
});

export function careAreaSpaceValues(auth: MemoryAuthorization) {
  // Legacy family records have group_id=NULL even when the verified turn came from a group.
  // Never use that storage partition as the audience of the current turn.
  return [auth.space?.spaceId ?? null, auth.space?.policyVersion ?? null, auth.userId, auth.groupId];
}
