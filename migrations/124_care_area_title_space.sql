-- A title is unique inside its audience, never across two private shared spaces.
-- NULLS NOT DISTINCT preserves the original legacy-family duplicate protection.
DROP INDEX care_areas_title;
CREATE UNIQUE INDEX care_areas_title
  ON care_areas(family_id, space_id, group_id, lower(title)) NULLS NOT DISTINCT
  WHERE status <> 'retired';
