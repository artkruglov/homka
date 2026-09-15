/**
 * Shared SQL policy for projecting external-group claims into a private context.
 *
 * Export:
 * - `externalProfileProjectionPredicate`: emits the single live-policy and provenance predicate.
 */

export function externalProfileProjectionPredicate(input: {
  claimAlias: string;
  viewerUserParameter: string;
}): string {
  const claim = input.claimAlias;
  const viewer = input.viewerUserParameter;
  return `(
    ${claim}.scope = 'group'
    AND ${claim}.profile_eligible = true
    AND ${claim}.sensitivity = 'normal'
    AND ${claim}.provenance_state = 'evidenced'
    AND NOT EXISTS (
      SELECT 1 FROM claim_evidence AS inferred_evidence
      WHERE inferred_evidence.claim_id = ${claim}.id
        AND inferred_evidence.evidence_kind = 'inferred'
    )
    AND EXISTS (
      SELECT 1
      FROM conversation_participants AS projected_subject
      JOIN external_profile_projection_policies AS live_projection
        ON live_projection.group_id = ${claim}.group_id
       AND live_projection.family_id = ${claim}.family_id
       AND live_projection.enabled = true
      JOIN external_profile_projection_notices AS delivered_notice
        ON delivered_notice.group_id = live_projection.group_id
       AND delivered_notice.policy_version = live_projection.policy_version
       AND delivered_notice.delivery_status = 'presented'
      WHERE projected_subject.id = ${claim}.subject_participant_id
        AND projected_subject.linked_user_id = ${viewer}
    )
    AND EXISTS (
      SELECT 1 FROM family_memberships AS current_member
      WHERE current_member.family_id = ${claim}.family_id
        AND current_member.user_id = ${viewer}
    )
  )`;
}
