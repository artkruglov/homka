/**
 * Как у каждой связанной с областью таблицы держится граница.
 *
 * Экспорт:
 * - `SpaceEnforcement`: способ удержания границы.
 * - `SPACE_ENFORCEMENT_EXCEPTIONS`: таблицы, чей способ отличается от выводимого по умолчанию.
 * - `spaceEnforcementFor`: способ для таблицы; `null` означает, что область к ней неприменима.
 *
 * Способ выводится из каталога переноса, а не перечисляется заново: у таблицы со своей границей
 * читатели обязаны фильтровать по `space_id`, у наследующей область приходит от родителя. Руками
 * записываются только исключения — и каждое с причиной, потому что молчаливое исключение и есть
 * дыра, ради закрытия которой этот каталог существует.
 */
import { legacyAuditCatalog } from "./legacy-space-audit-catalog.js";

export type SpaceEnforcement =
  /** Читатели и писатели обязаны нести оговорку `spaceReadClause` по собственной колонке. */
  | "sql_space_clause"
  /** Область приходит от родителя и проверяется вместе с ним. */
  | "parent_inherited"
  /** Аудитории не обслуживает: фоновый рабочий без человека на другом конце. */
  | "service_global"
  /** Только обслуживание: миграции, ретенция, очереди. */
  | "maintenance_only"
  /** Сама граница: строка не ограничена областью, а задаёт её состав и аудиторию. */
  | "audience_definition";

export interface SpaceEnforcementException {
  readonly enforcement: SpaceEnforcement;
  readonly reason: string;
}

export const SPACE_ENFORCEMENT_EXCEPTIONS: Readonly<Record<string, SpaceEnforcementException>> = {
  memory_embedding_chunks: {
    enforcement: "service_global",
    reason: "Индекс эмбеддингов не отвечает человеку; область копируется от записи и нужна только связке",
  },
  memory_embedding_jobs: {
    enforcement: "service_global",
    reason: "Очередь индексации выбирается работником целиком и не обслуживает ни один чат",
  },
  memory_items: {
    enforcement: "sql_space_clause",
    reason: "Представление над memory_items_all: читатели несут ту же оговорку, что и у таблицы",
  },
  private_chat_active_spaces: {
    enforcement: "sql_space_clause",
    reason: "Выбор человека читается только вместе с живым членством в выбранной области",
  },
  space_bindings: {
    enforcement: "audience_definition",
    reason: "Привязка чата к области и есть граница: ограничивать её областью нечем",
  },
  space_memberships: {
    enforcement: "audience_definition",
    reason: "Состав области и есть граница: по нему проверяются все остальные таблицы",
  },
  telegram_chat_audience_proofs: {
    enforcement: "audience_definition",
    reason: "Доказательство аудитории принадлежит области и версии политики, а не наоборот",
  },
};

/** Таблицы без привязки к области: идентичность, метаданные переноса, очереди и журналы. */
export function spaceEnforcementFor(table: string): SpaceEnforcement | null {
  const exception = SPACE_ENFORCEMENT_EXCEPTIONS[table];
  if (exception) return exception.enforcement;
  const rule = legacyAuditCatalog[table];
  if (!rule || rule.action !== "map") return null;
  return rule.boundary ? "sql_space_clause" : "parent_inherited";
}
