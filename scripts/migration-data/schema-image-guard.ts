/**
 * Запрет «старый образ на новой схеме».
 *
 * Экспорт:
 * - `requireSchemaWithinImage`: падает, если в журнале есть миграции, которых нет в образе.
 *
 * Старый образ на новой схеме хуже остановленного сервиса: он читает данные предикатами, которых
 * схема уже не подразумевает, и молча расширяет аудиторию прежних записей. Сервис миграции —
 * предусловие всех остальных, поэтому такой стек просто не поднимается.
 */
interface LedgerClient {
  query(sql: string): Promise<{ rows: { name: string }[] }>;
}

export async function requireSchemaWithinImage(
  client: LedgerClient,
  known: readonly string[],
): Promise<void> {
  const applied = await client.query("SELECT name FROM schema_migrations ORDER BY name");
  const names = new Set(known);
  const unknown = applied.rows.map((row) => row.name).filter((name) => !names.has(name));
  if (unknown.length === 0) return;
  throw new Error(
    `AGENT_SCHEMA_AHEAD_OF_IMAGE: База уже содержит миграции, которых нет в образе: ${unknown.join(", ")}`,
  );
}
