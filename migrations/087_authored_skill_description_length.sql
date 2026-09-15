-- Описание навыка это триггер загрузки: задача плюс косвенные формулировки. В офлайн-прогоне
-- DeepSeek Flash писал 215–231 символ по-русски, лимит 200 отклонял хорошие описания.
ALTER TABLE authored_skills DROP CONSTRAINT authored_skills_description_check;
ALTER TABLE authored_skills
  ADD CONSTRAINT authored_skills_description_check
    CHECK (char_length(description) BETWEEN 1 AND 400);
