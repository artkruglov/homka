-- Передача ответственности. Прежде исполнитель записывался один раз при вставке, и ни один UPDATE
-- его не трогал: «подмени меня» было невыразимо, а отказ исполнителя — тем более.
--
-- Запрос передачи это состояние самой задачи, а не отдельная жизнь: до согласия получателя
-- ответственным остаётся прежний исполнитель, и это видно в той же строке.
ALTER TABLE shared_tasks
  ADD COLUMN pending_assignee_telegram_id text,
  ADD COLUMN transfer_requested_at timestamptz,
  ADD CONSTRAINT shared_tasks_transfer_shape CHECK (
    (pending_assignee_telegram_id IS NULL) = (transfer_requested_at IS NULL)
  ),
  -- Передавать можно только принятое дело и только другому человеку.
  ADD CONSTRAINT shared_tasks_transfer_target CHECK (
    pending_assignee_telegram_id IS NULL OR (
      status = 'accepted' AND assignee_telegram_id IS NOT NULL
        AND pending_assignee_telegram_id <> assignee_telegram_id
    )
  );
CREATE INDEX shared_tasks_pending_assignee
  ON shared_tasks(family_id, pending_assignee_telegram_id)
  WHERE pending_assignee_telegram_id IS NOT NULL;
