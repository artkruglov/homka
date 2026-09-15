-- Активная область личного чата. Читать человек может все свои области сразу, но новая запись
-- обязана попасть ровно в одну: догадываться по содержанию, куда её отнести, нельзя.
--
-- Выбор хранится на человека, а не на разговор: личный чат у него один, а сессии в нём меняются.
CREATE TABLE private_chat_active_spaces (
  family_id uuid NOT NULL,
  user_id uuid NOT NULL,
  space_id uuid NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, user_id),
  FOREIGN KEY (family_id, user_id) REFERENCES family_memberships(family_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (family_id, space_id) REFERENCES spaces(family_id, id) ON DELETE CASCADE
);
