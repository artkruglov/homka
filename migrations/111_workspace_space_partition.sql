-- Файл принадлежит области так же, как запись памяти. Точка контроля для нативных `bash`,
-- `read_file` и `write_file` в доверенном чате — набор монтирований, а не обёртка инструмента,
-- поэтому область обязана менять сам физический корень: один и тот же `/workspace/family` в двух
-- общих областях одной семьи иначе указывал бы на одни и те же файлы.
--
-- Прежний ключ уникальности делал это невозможным: он не различал области. Перенос 104 уже
-- проставил каждой строке её область, поэтому смена ключа ничего не разделяет задним числом —
-- прежние чаты продолжают открывать те же корни.
ALTER TABLE workspaces DROP CONSTRAINT workspaces_family_id_scope_owner_user_id_group_id_key;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_area_partition
  UNIQUE NULLS NOT DISTINCT (family_id, scope, owner_user_id, group_id, space_id);
