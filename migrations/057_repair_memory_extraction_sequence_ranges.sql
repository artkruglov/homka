-- Every extraction batch must retain at least one immutable snapshot coordinate. Refuse to infer a
-- range when the source of truth is absent instead of silently preserving an invalid boundary.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM memory_extraction_ranges AS range
    LEFT JOIN memory_extraction_snapshot_entries AS snapshot ON snapshot.batch_id = range.batch_id
    GROUP BY range.batch_id
    HAVING count(snapshot.id) = 0
  ) THEN
    RAISE EXCEPTION
      'AGENT_MEMORY_EXTRACTION_RANGE_REPAIR_SOURCE_MISSING: extraction range has no snapshot entries';
  END IF;
END
$$;

-- Earlier code sorted a bigint output alias after casting it to text. Recompute only the numeric
-- boundaries; snapshot ordinal and payload hashes remain untouched as exact provider-call evidence.
WITH exact_ranges AS (
  SELECT batch_id, min(sequence_id) AS first_sequence, max(sequence_id) AS last_sequence
  FROM memory_extraction_snapshot_entries
  GROUP BY batch_id
)
UPDATE memory_extraction_ranges AS range
SET first_sequence = exact.first_sequence,
    last_sequence = exact.last_sequence,
    updated_at = now()
FROM exact_ranges AS exact
WHERE exact.batch_id = range.batch_id
  AND (range.first_sequence, range.last_sequence)
    IS DISTINCT FROM (exact.first_sequence, exact.last_sequence);
