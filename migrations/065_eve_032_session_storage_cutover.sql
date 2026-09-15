-- The migration runner executes this complete file in one transaction. Audit every incompatible
-- application session before FK actions remove executable routes and HITL approvals.
INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
SELECT family_id,
       'session.eve_032_storage_cutover',
       id,
       jsonb_strip_nulls(jsonb_build_object(
         'diagnosticCode', 'AGENT_EVE_032_SESSION_CUTOVER',
         'fromEveVersion', '0.22.5',
         'toEveVersion', '0.32.0',
         'eveSessionId', eve_session_id,
         'sessionKind', kind::text,
         'generation', generation
       ))
  FROM conversation_sessions;

-- A leased parent whose run crossed dispatch cannot be safely replayed on the empty Eve 0.32
-- store. Release its lease and retain a terminal diagnostic for operator-visible history.
UPDATE agent_schedules AS schedule
   SET status = 'failed',
       lease_token = NULL,
       lease_expires_at = NULL,
       dispatch_started_at = NULL,
       last_error_code = 'AGENT_EVE_032_SESSION_CUTOVER',
       updated_at = now()
 WHERE schedule.status = 'leased'
   AND EXISTS (
     SELECT 1
       FROM agent_schedule_runs AS run
      WHERE run.schedule_id = schedule.id
        AND run.status IN ('dispatching', 'running')
   );

-- Dispatching/running runs may already have paid calls or side effects. Ambiguous is deliberately
-- non-retryable, while completed/failed/ambiguous history remains byte-for-byte terminal.
UPDATE agent_schedule_runs
   SET status = 'ambiguous',
       completed_at = now(),
       error_code = 'AGENT_EVE_032_SESSION_CUTOVER',
       updated_at = now()
 WHERE status IN ('dispatching', 'running');

-- Telegram dispatch and an unfinished voice provider call have no safe replay boundary. Preserve
-- their markers, clear the lease, and expose a stable diagnostic without touching terminal rows.
UPDATE telegram_ingress_updates
   SET status = 'failed',
       lease_token = NULL,
       lease_expires_at = NULL,
       completed_at = now(),
       last_error_code = 'AGENT_EVE_032_SESSION_CUTOVER',
       last_error_message = 'Обработка была остановлена при обновлении хранилища сессий; автоматический повтор отключён',
       updated_at = now()
 WHERE status = 'processing'
   AND (
     dispatch_started_at IS NOT NULL OR
     (voice_transcription_started_at IS NOT NULL AND voice_transcript IS NULL)
   );

-- Before Eve dispatch, a row is retryable only when no voice provider call started or its transcript
-- was durably saved. The worker reuses a saved transcript and never pays for a second transcription.
UPDATE telegram_ingress_updates
   SET status = 'pending',
       lease_token = NULL,
       lease_expires_at = NULL,
       completed_at = NULL,
       last_error_code = NULL,
       last_error_message = NULL,
       updated_at = now()
 WHERE status = 'processing'
   AND dispatch_started_at IS NULL
   AND (voice_transcription_started_at IS NULL OR voice_transcript IS NOT NULL);

-- Real FKs preserve application-owned history: routes/HITL cascade, while timeline, schedule runs,
-- extraction provenance, final deliveries, and self-links use SET NULL.
DELETE FROM conversation_sessions;
