-- The communication-style slot key named the persona ("общение с Мией"). The persona name is now
-- installation configuration (TELEGRAM_AGENT_NAME), so the key is neutral; existing records keep
-- their slot under the new key. Attribute updates fire no memory triggers.
UPDATE memory_items_all
   SET attribute = 'общение с ассистентом'
 WHERE attribute = 'общение с Мией';
