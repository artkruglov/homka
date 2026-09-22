-- Пока предложение не принято, за область отвечает прежний хозяин.
--
-- `propose` снимал хозяина сразу, и отказ оставлял область вообще без ответственного: правило
-- «до согласия отвечаю я» работало у дел, но не у областей заботы. Состояние `proposed` теперь
-- допускает хозяина; «предложено никому» по-прежнему непредставимо.
ALTER TABLE care_areas DROP CONSTRAINT care_areas_state_shape;
ALTER TABLE care_areas ADD CONSTRAINT care_areas_state_shape CHECK (
  (status = 'open' AND owner_telegram_id IS NULL AND pending_owner_telegram_id IS NULL) OR
  (status = 'proposed' AND pending_owner_telegram_id IS NOT NULL
    AND (owner_telegram_id IS NULL OR accepted_at IS NOT NULL)) OR
  (status = 'accepted' AND owner_telegram_id IS NOT NULL AND pending_owner_telegram_id IS NULL
    AND accepted_at IS NOT NULL) OR
  (status = 'retired' AND pending_owner_telegram_id IS NULL)
);
