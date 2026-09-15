-- Enum additions must commit before the next migration uses the new values in constraints.
ALTER TYPE agent_schedule_scope ADD VALUE 'group';
ALTER TYPE proactive_delivery_scope ADD VALUE 'group';
