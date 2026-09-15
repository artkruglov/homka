/** Frozen v103 catalog for migration 104. Never extend this historical snapshot for later migrations. */
/** Explicit migration dispositions, not runtime authorization. SQL expressions are authored constants. */
export interface LegacyParent { table: string; field: string; target?: string; optional?: boolean }
export interface LegacyBoundary { family: string; scope: string; owner: string; group: string }
export interface LegacyAuditRule {
  action: "map" | "rebuild" | "quarantine" | "drain" | "control";
  reason: string;
  boundary?: LegacyBoundary;
  parents?: LegacyParent[];
  joins?: Array<{ table: string; alias: string; on: string }>;
  guards?: string[];
  pendingWhere?: string;
  pendingAction?: "retire";
  separateAudience?: boolean;
  /** Only provenance tombstones with no content or remaining audience. */
  retainedControlWhere?: string;
}

const rules: Record<string, LegacyAuditRule> = {};
function add(names: string, rule: LegacyAuditRule) {
  for (const name of names.split(/\s+/u).filter(Boolean)) {
    if (rules[name]) throw new Error(`Duplicate legacy disposition: ${name}`);
    rules[name] = { ...rule };
  }
}
const scoped = (owner: string, group: string): LegacyAuditRule => ({
  action: "map", reason: "Preserve the exact legacy scope and audience snapshot",
  boundary: { family: "x.family_id", scope: "x.scope", owner, group },
});
const partitioned = scoped("x.scope_partition_key", "x.scope_partition_key");
add(`application_conversations claim_conflicts claim_evidence claim_relations
  confirmed_outcome_source_claims confirmed_outcomes conversation_participants
  memory_consolidation_job_candidates memory_consolidation_jobs memory_extraction_batches
  memory_items_all memory_projects memory_thread_creation_attempts memory_thread_discovery_jobs
  memory_thread_discovery_sources memory_thread_entries memory_threads`, {
  ...partitioned,
  guards: ["(x.scope <> 'family' OR x.scope_partition_key=x.family_id)"],
});
add("workspaces reminders agent_schedules proactive_deliveries conversation_sessions", scoped("x.owner_user_id", "x.group_id"));
rules.conversation_sessions!.pendingWhere = "x.retired_at IS NULL";
rules.conversation_sessions!.pendingAction = "retire";
// Each entry must have its own object before attaching table-specific checks.
rules.memory_items_all = { ...rules.memory_items_all!, guards: [
  ...rules.memory_items_all!.guards!,
  "(x.scope <> 'personal' OR x.owner_user_id=x.scope_partition_key)",
  "(x.scope <> 'group' OR x.group_id=x.scope_partition_key)",
] };
rules.application_conversations = { ...rules.application_conversations!, guards: [
  ...rules.application_conversations!.guards!,
  "(x.scope <> 'personal' OR x.owner_user_id=x.scope_partition_key)",
  "(x.scope <> 'group' OR x.telegram_group_id=x.scope_partition_key)",
] };
add("telegram_groups", {
  action: "map", reason: "Registration remains in its exact old conversation boundary",
  boundary: { family: "x.family_id", scope: "CASE WHEN x.type='external' THEN 'group' ELSE 'family' END::memory_scope", owner: "NULL::uuid", group: "x.id" },
});
add("shared_tasks", {
  ...scoped("u.id", "x.group_id"), joins: [{ table: "users", alias: "u", on: "u.telegram_user_id=x.creator_telegram_id" }],
  guards: ["(x.scope <> 'personal' OR x.creator_telegram_id=x.assignee_telegram_id)"],
});
add("authored_skills", {
  action: "map", reason: "The previously shared family skill library stays with its old readers",
  boundary: { family: "x.family_id", scope: "'family'::memory_scope", owner: "NULL::uuid", group: "NULL::uuid" },
});

function inherit(names: string, parent: string, field: string, ownFamily = false, target = "id") {
  add(names, { action: "map", reason: `Preserve the boundary of ${parent}`,
    parents: [{ table: parent, field, target }],
    guards: ownFamily ? ["x.family_id=p0._family_id"] : [],
  });
}
inherit("agent_schedule_operations agent_schedule_runs agent_schedule_history_snapshots", "agent_schedules", "schedule_id", true);
inherit("agent_schedule_history_chunks", "agent_schedule_history_snapshots", "run_id", false, "run_id");
inherit("authored_skill_examples authored_skill_versions authored_skill_group_grants", "authored_skills", "skill_id", true);
inherit("authored_skill_usage conversation_skill_hints", "application_conversations", "conversation_id", true);
inherit("behavior_preferences conversation_extraction_cursors memory_extraction_entry_coverage memory_extraction_gaps memory_extraction_ranges memory_extraction_retention_holds memory_review_lanes memory_review_batches memory_review_batch_sources memory_turn_source_sets memory_turn_sources profile_subjects telegram_group_message_ids telegram_group_messages", "application_conversations", "conversation_id");
inherit("confirmed_outcome_operations", "confirmed_outcomes", "outcome_id", true);
inherit("external_profile_projection_notices external_profile_projection_policies external_profile_projection_policy_operations", "telegram_groups", "group_id", true);
inherit("image_generation_operations workspace_operations workspace_deletion_jobs", "workspaces", "workspace_id");
inherit("workspace_file_deliveries integration_accounts oauth_authorizations", "workspaces", "workspace_id", true);
inherit("integration_credentials", "integration_accounts", "account_id");
inherit("memory_conflict_resolution_operations", "claim_conflicts", "conflict_id", true);
inherit("memory_embedding_chunks memory_embedding_jobs memory_item_refs", "memory_items_all", "memory_item_id");
inherit("memory_mutation_operations", "memory_items_all", "memory_item_id", true);
inherit("memory_extraction_approval_notices", "application_conversations", "conversation_id", true);
inherit("memory_extraction_candidates memory_extraction_jobs memory_extraction_semantic_results memory_extraction_snapshot_entries", "memory_extraction_batches", "batch_id");
inherit("memory_extraction_candidate_sources", "memory_extraction_candidates", "candidate_row_id");
inherit("memory_review_owner_alerts", "memory_review_batches", "batch_id", true);
inherit("memory_sensitive_approval_decisions", "memory_items_all", "resolved_claim_id", true);
inherit("memory_thread_briefs memory_thread_brief_jobs", "memory_threads", "thread_id");
inherit("memory_thread_brief_blocks memory_thread_brief_block_sources", "memory_thread_briefs", "brief_id");
inherit("memory_thread_creation_notices memory_thread_lifecycle_operations", "memory_threads", "thread_id", true);
inherit("memory_thread_discovery_claim_coverage", "memory_items_all", "source_claim_id");
inherit("memory_thread_discovery_existing", "memory_thread_discovery_jobs", "job_id");
inherit("reminder_operations", "reminders", "reminder_id", true);
inherit("shared_ritual_occurrences shared_task_versions", "shared_tasks", "task_id");
inherit("shared_task_operations", "shared_tasks", "task_id", true);
inherit("telegram_final_deliveries telegram_progress_notices telegram_hitl_approvals", "conversation_sessions", "application_session_id");
inherit("telegram_final_delivery_chunks", "telegram_final_deliveries", "delivery_id");
// Session retention deliberately leaves delivered deduplication receipts behind. They must not
// acquire guessed readers or be deleted (which could permit duplicate delivery).
rules.telegram_final_deliveries!.retainedControlWhere = "x.application_session_id IS NULL AND x.status='delivered'";
rules.telegram_final_delivery_chunks!.retainedControlWhere = "p0._retained_control";
rules.telegram_progress_notices!.retainedControlWhere = "x.application_session_id IS NULL AND x.sent_at IS NOT NULL AND x.telegram_message_id IS NOT NULL";

// An actor's plan is private even when its task comes from a group. Never inherit the task audience.
add("shared_task_plans", {
  action: "map", reason: "Keep each participant's planning dates in their own personal space",
  parents: [{ table: "shared_tasks", field: "task_id" }],
  joins: [{ table: "users", alias: "u", on: "u.telegram_user_id=x.telegram_user_id" }],
  boundary: { family: "p0._family_id", scope: "'personal'::memory_scope", owner: "u.id", group: "NULL::uuid" },
  guards: ["p0._space_id IS NOT NULL"],
  separateAudience: true,
});

// These links must agree with the declared scope, not merely exist somewhere in the same family.
function links(table: string, parents: LegacyParent[]) {
  rules[table] = { ...rules[table]!, parents };
}
links("claim_conflicts", [{ table: "memory_items_all", field: "claim_a_id" }, { table: "memory_items_all", field: "claim_b_id" }]);
links("claim_evidence", [{ table: "memory_items_all", field: "claim_id" }]);
links("claim_relations", [{ table: "memory_items_all", field: "source_claim_id" }, { table: "memory_items_all", field: "target_claim_id" }]);
links("confirmed_outcome_source_claims", [{ table: "confirmed_outcomes", field: "outcome_id" }, { table: "memory_items_all", field: "source_claim_id" }]);
links("memory_consolidation_job_candidates", [{ table: "memory_consolidation_jobs", field: "job_id" }, { table: "memory_items_all", field: "existing_claim_id" }]);
links("memory_thread_discovery_sources", [{ table: "memory_thread_discovery_jobs", field: "job_id" }, { table: "memory_items_all", field: "source_claim_id" }]);
links("memory_thread_entries", [{ table: "memory_threads", field: "thread_id" }, { table: "memory_items_all", field: "source_claim_id", optional: true }, { table: "confirmed_outcomes", field: "source_outcome_id", optional: true }]);
rules.profile_subjects = { ...rules.profile_subjects!, guards: ["x.family_id=p0._family_id"] };
links("memory_extraction_candidate_sources", [{ table: "memory_extraction_candidates", field: "candidate_row_id" }, { table: "memory_extraction_batches", field: "batch_id" }, { table: "memory_extraction_snapshot_entries", field: "snapshot_entry_id" }]);
links("memory_extraction_snapshot_entries", [{ table: "memory_extraction_batches", field: "batch_id" }, { table: "application_conversations", field: "conversation_id" }]);
links("memory_extraction_ranges", [{ table: "application_conversations", field: "conversation_id" }, { table: "memory_extraction_batches", field: "batch_id" }]);

add("profile_views profile_view_subjects profile_view_claims memory_context_exposures profile_author_exposures", {
  action: "rebuild", reason: "Discard derived context snapshots; rebuild only under the new current policy",
});
add("conversation_session_routes", {
  action: "rebuild", reason: "Clear old continuation routes after retiring sessions; never carry a mixed model summary",
});
add("audit_events agent_improvement_items", {
  action: "quarantine", reason: "Opaque operational metadata/evidence can contain mixed sources; no automatic family publication",
});
add("telegram_ingress_updates", {
  action: "drain", reason: "Drain or explicitly resolve ingress before cutover; preserve terminal deduplication receipts",
  pendingWhere: "x.status IN ('pending','processing')",
});

// Control means retain under its existing dedicated authorization, never grant family-wide read access.
add("families family_memberships invitations bootstrap_codes users shared_task_participants", {
  action: "control", reason: "Identity/registration data retains dedicated current membership checks; it is not chat memory",
});
add("spaces space_memberships space_bindings", { action: "control", reason: "Target audience metadata, not legacy content" });
add("user_notification_settings", { action: "control", reason: "User-owned settings retain their exact user-only authorization" });
add("software_update_proposals owner_health_digests memory_exports", {
  action: "control", reason: "Retain operation receipts under operator/requester checks; cutover does not revive or replay requests",
});
add("conversation_route_generations eve_session_event_cursors telegram_ingress_continuation_aliases telegram_ingress_ignored_updates telegram_ingress_queues", {
  action: "control", reason: "Retain monotonic/deduplication metadata; deleting it could replay an old side effect",
});
add("schema_migrations telegram_chat_reaction_policies", { action: "control", reason: "Schema ledger or public Telegram protocol metadata" });
add("memory_items", { action: "control", reason: "Soft-delete view: migration must account for memory_items_all including retained deleted rows" });

export const legacyAuditCatalog: Readonly<Record<string, LegacyAuditRule>> = rules;
