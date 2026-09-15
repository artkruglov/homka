-- Потомки напоминания и расписания читаются только через своего родителя, поэтому пустая область
-- утечки им не даёт. Но ворота переключения требуют, чтобы несвязанных строк не оставалось вовсе,
-- а перечислять места вставки значит однажды забыть одно: строки запусков и журналов операций
-- заводит диспетчер, а не ход человека. Наследование тем же инвариантом схемы, что и у 109.
DO $$
DECLARE inheritance text[][] := ARRAY[
  ['agent_schedule_operations', 'agent_schedules', 'schedule_id'],
  ['agent_schedule_runs', 'agent_schedules', 'schedule_id'],
  ['agent_schedule_history_snapshots', 'agent_schedules', 'schedule_id'],
  ['reminder_operations', 'reminders', 'reminder_id']
];
  entry text[];
BEGIN
  FOREACH entry SLICE 1 IN ARRAY inheritance LOOP
    EXECUTE format(
      'CREATE TRIGGER space_inheritance BEFORE INSERT ON %I
         FOR EACH ROW EXECUTE FUNCTION inherit_space_from_parent(%L, %L)',
      entry[1], entry[2], entry[3]);
  END LOOP;
END $$;

-- Прежние строки, оставшиеся без области после того, как родитель её получил.
UPDATE agent_schedule_runs child SET space_id = parent.space_id
  FROM agent_schedules parent
 WHERE parent.id = child.schedule_id AND child.space_id IS NULL AND parent.space_id IS NOT NULL;
UPDATE reminder_operations child SET space_id = parent.space_id
  FROM reminders parent
 WHERE parent.id = child.reminder_id AND child.space_id IS NULL AND parent.space_id IS NOT NULL;
