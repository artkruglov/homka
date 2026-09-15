-- Повторяющееся дело. У дел не было ни одного поля повтора: `kind='ritual'` это ручная отметка
-- выполнения, а не правило. «По пятницам проверить расходники» приходилось заводить заново руками.
--
-- Повтор считается по календарным датам, а не по точному времени: у дела нет своего часового
-- пояса, и выдумывать его ради правила нельзя. Точное время остаётся сроком одного вхождения.
ALTER TABLE shared_tasks
  ADD COLUMN recurrence_unit text
    CHECK (recurrence_unit IN ('daily', 'weekly', 'monthly', 'after_completion')),
  ADD COLUMN recurrence_interval integer CHECK (recurrence_interval BETWEEN 1 AND 365),
  ADD COLUMN occurrence_index integer NOT NULL DEFAULT 0 CHECK (occurrence_index >= 0),
  ADD COLUMN recurrence_anchor_on date,
  ADD CONSTRAINT shared_tasks_recurrence_shape CHECK (
    (recurrence_unit IS NULL AND recurrence_interval IS NULL AND recurrence_anchor_on IS NULL) OR
    (recurrence_unit IS NOT NULL AND recurrence_interval IS NOT NULL
      AND recurrence_anchor_on IS NOT NULL AND kind = 'task' AND due_on IS NOT NULL)
  );
