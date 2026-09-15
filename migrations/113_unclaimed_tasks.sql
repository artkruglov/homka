-- Дело без исполнителя: «кто заберёт посылку?» — это не назначение автору и не поручение
-- конкретному человеку. Прежняя схема такого состояния не допускала (`assignee_telegram_id NOT
-- NULL`), поэтому вопрос в чат превращался либо в дело автора, либо не сохранялся вовсе.
--
-- Инвариант один и держится схемой: свободное дело — ровно то, у которого нет исполнителя.
ALTER TABLE shared_tasks
  ALTER COLUMN assignee_telegram_id DROP NOT NULL,
  DROP CONSTRAINT shared_tasks_status_check,
  ADD CONSTRAINT shared_tasks_status_check
    CHECK (status IN ('open','proposed','accepted','completed','declined','cancelled')),
  ADD CONSTRAINT shared_tasks_open_has_no_assignee
    CHECK ((status = 'open') = (assignee_telegram_id IS NULL)),
  -- Личное дело всегда чьё-то: взять его больше некому, а `creator = assignee` при NULL даёт
  -- неопределённость, то есть прежняя проверка пропустила бы такую строку молча.
  ADD CONSTRAINT shared_tasks_personal_has_assignee
    CHECK (scope <> 'personal' OR assignee_telegram_id IS NOT NULL),
  -- Идея и традиция никому не поручаются и потому не бывают свободными.
  ADD CONSTRAINT shared_tasks_open_is_a_task CHECK (status <> 'open' OR kind = 'task');

CREATE INDEX shared_tasks_open ON shared_tasks(family_id, group_id, status) WHERE status = 'open';
