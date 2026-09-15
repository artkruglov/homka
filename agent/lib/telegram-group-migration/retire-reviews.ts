/** Close old-address review turns under the operator's paused-writers boundary.
 * Original sources and lane identities remain in the same conversation.
 */
import type { PoolClient } from "pg";
import { resolveAbandonedReviewBatch } from "../memory-review/memory-review-terminal-repository.js";

export async function retireMigratedGroupReviews(client: PoolClient, groupId: string) {
  const lanes = await client.query<{ id: string }>(`SELECT lane.id FROM memory_review_lanes lane
    JOIN application_conversations conversation ON conversation.id=lane.conversation_id
    WHERE conversation.telegram_group_id=$1 ORDER BY lane.id FOR UPDATE OF lane`, [groupId]);
  for (const lane of lanes.rows) {
    const batches = await client.query<{
      id: string; application_session_id: string | null;
      eve_session_id: string | null; eve_turn_id: string | null;
    }>(`SELECT id,application_session_id,eve_session_id,eve_turn_id FROM memory_review_batches
      WHERE lane_id=$1 AND status NOT IN ('completed','skipped')
      ORDER BY predecessor_sequence DESC FOR UPDATE`, [lane.id]);
    // Release unwritten successors first so an entirely unwritten chain can be reviewed again.
    // A written/completed successor remains: the existing lifecycle preserves its cursor anchor.
    for (const batch of batches.rows) {
      await resolveAbandonedReviewBatch(client, {
        applicationSessionId: batch.application_session_id,
        batchId: batch.id,
        diagnosticCode: "AGENT_TELEGRAM_GROUP_MIGRATED",
        eveSessionId: batch.eve_session_id,
        eveTurnId: batch.eve_turn_id,
        laneId: lane.id,
        notifyOwner: true,
        now: new Date(),
      });
    }
  }
}
