-- Bind every new notice to the exact private conversation allowed to present it. Legacy creation
-- provenance is accepted only from the entry written no later than the notice itself; deleted or
-- otherwise ambiguous creation evidence fails closed instead of leaking a delayed group notice.
ALTER TABLE memory_thread_creation_notices
  ADD COLUMN origin_conversation_id uuid REFERENCES application_conversations(id) ON DELETE CASCADE;

UPDATE memory_thread_creation_notices AS notice
SET origin_conversation_id = (
  SELECT evidence.origin_conversation_id
  FROM memory_thread_entries AS entry
  JOIN claim_evidence AS evidence
    ON evidence.claim_id = entry.source_claim_id AND evidence.evidence_role = 'primary'
  WHERE entry.thread_id = notice.thread_id
    AND entry.created_at <= notice.created_at
  ORDER BY entry.created_at, entry.id
  LIMIT 1
)
WHERE notice.origin_conversation_id IS NULL;

UPDATE memory_thread_creation_notices AS notice
SET status = 'failed',
    delivery_started_at = now(),
    delivery_diagnostic_code = 'AGENT_MEMORY_THREAD_NOTICE_PRIVATE_ONLY'
WHERE notice.status = 'pending'
  AND (
    notice.origin_conversation_id IS NULL OR EXISTS (
      SELECT 1
      FROM application_conversations AS conversation
      WHERE conversation.id = notice.origin_conversation_id
        AND conversation.telegram_group_id IS NOT NULL
    )
  );

ALTER TABLE memory_thread_creation_notices
  ADD CONSTRAINT memory_thread_creation_notices_pending_origin CHECK (
    status <> 'pending' OR origin_conversation_id IS NOT NULL
  );

CREATE INDEX memory_thread_creation_notices_origin_conversation
  ON memory_thread_creation_notices(origin_conversation_id)
  WHERE origin_conversation_id IS NOT NULL;
