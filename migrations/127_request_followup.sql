-- A response check must never become an execution reminder after reassignment.
ALTER TABLE reminders ADD COLUMN task_reminder_kind text NOT NULL DEFAULT 'execution'
  CHECK (task_reminder_kind IN ('execution','response'));
ALTER TABLE reminders ADD CONSTRAINT reminder_response_link_required
  CHECK (task_reminder_kind <> 'response' OR (shared_task_id IS NOT NULL AND scope='personal'));
