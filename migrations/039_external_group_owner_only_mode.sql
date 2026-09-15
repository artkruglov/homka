-- Owner-only dispatch keeps the external group timeline available for summaries while allowing
-- only the current Osinara owner to wake the model. Family groups retain their member access model.
ALTER TYPE telegram_group_message_mode ADD VALUE 'owner_only';
