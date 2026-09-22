-- Коуч: короткие вопросы не про дела, а про время для себя, традиции и то, что порадовало.
--
-- Документ о балансе семьи задуман пассивным: первый разговор о традициях оставлен людям, и за
-- месяц он не состоялся ни разу (22 сентября 2026: 35 дел, ноль идей и ноль традиций). Коуч это
-- тот же вид «бот начал разговор» с тем же выключателем, пределом и паузой после молчания, но
-- включается только явным «да» человека: `coach_enabled` NULL значит «ещё не спрашивали».
--
-- Касание и утренний обзор пишутся в журнал доставок, иначе ответ человека приходит в ход,
-- который не видел вопроса. Источник доставки это uuid, поэтому журнал инициативы получает
-- собственный uuid строки.
ALTER TYPE initiative_kind ADD VALUE 'coach';
ALTER TYPE proactive_delivery_source_kind ADD VALUE 'daily_overview';
ALTER TYPE proactive_delivery_source_kind ADD VALUE 'coach';

ALTER TABLE user_notification_settings ADD COLUMN coach_enabled boolean;

ALTER TABLE initiative_messages
  ADD COLUMN delivery_ref uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN coach_reason text CHECK (coach_reason IN (
    'invite', 'decision_open', 'ritual_checkin', 'week_warm', 'rest_window_missing', 'ritual_none')),
  ADD COLUMN coach_subject uuid;
CREATE UNIQUE INDEX initiative_messages_delivery_ref ON initiative_messages(delivery_ref);
