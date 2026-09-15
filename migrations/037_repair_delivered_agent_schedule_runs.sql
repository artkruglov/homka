-- A Telegram delivery receipt is durable proof that replay is forbidden and the historical run
-- succeeded, even when an older release missed the later turn-completion transition.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM agent_schedule_runs AS run
      JOIN agent_schedules AS schedule ON schedule.id = run.schedule_id
      JOIN proactive_deliveries AS delivery
        ON delivery.source_kind = 'agent_schedule' AND delivery.source_id = run.id
     WHERE run.status IN ('running', 'ambiguous')
       AND schedule.status NOT IN ('active', 'completed')
  ) THEN
    RAISE EXCEPTION
      'AGENT_SCHEDULE_DELIVERY_REPAIR_PARENT_INVALID: receipt-backed run has an unresolved parent schedule';
  END IF;
END $$;

WITH delivered AS (
  SELECT source_id AS run_id, max(delivered_at) AS delivered_at
    FROM proactive_deliveries
   WHERE source_kind = 'agent_schedule'
   GROUP BY source_id
)
UPDATE agent_schedule_runs AS run
   SET status = 'completed',
       completed_at = delivered.delivered_at,
       error_code = NULL,
       updated_at = greatest(run.updated_at, delivered.delivered_at)
  FROM delivered
 WHERE run.id = delivered.run_id
   AND run.status IN ('running', 'ambiguous');
