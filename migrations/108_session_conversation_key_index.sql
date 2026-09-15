-- `initialGeneration` и поиск текущей сессии выбирают строки по `conversation_key`, а индекса на
-- нём не было: у тихой проверки памяти ключ уникален для каждого пакета, поэтому минутный
-- диспетчер сканировал таблицу сессий целиком на каждый пакет каждого лейна.
CREATE INDEX conversation_sessions_conversation_key
  ON conversation_sessions (conversation_key, generation DESC);
