-- A memory-review batch that reached Eve and never reported back used to be released by deleting
-- its row. That is only safe while nothing stands behind it: later batches chain onto a stuck head
-- through `coveredThrough`, and deleting the head leaves them unreachable from the lane cursor,
-- which either replays already reviewed messages or breaks the minute sweep on the unique source
-- binding. The new terminal value marks such a head as skipped instead: it stays in the chain, so
-- the cursor moves past it, and its row survives for a repeated Eve lifecycle event.
-- The value lands in its own migration because PostgreSQL forbids using a freshly added enum value
-- in the transaction that added it, and every file here is one transaction.
ALTER TYPE memory_review_batch_status ADD VALUE IF NOT EXISTS 'skipped';
