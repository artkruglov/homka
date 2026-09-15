/**
 * Единый вывод раздела записи памяти.
 *
 * Экспорт:
 * - `ClaimPartition`: прежний ключ раздела и область записи.
 * - `resolveClaimPartition`: выводит обе части из проверенной авторизации.
 *
 * Раздел выводился независимо в четырёх местах — у писателя заявлений, у нитей, у квоты и у
 * проверки источника. Пока значение одно, расхождение незаметно; с появлением области оно означало
 * бы, что запись и её потомки попадают в разные места, а составной отложенный ключ покажет это
 * только на `COMMIT`.
 */
import { AppError } from "./app-error.js";
import { validatedMemorySpace, type MemoryAuthorization, type MemoryScope } from "./memory-context.js";

export interface ClaimPartition {
  /** Прежний ключ раздела: человек, группа или семья. Остаётся вторым, независимым ограничением. */
  readonly scopePartitionKey: string;
  /** Область хода; `null`, пока режим семьи прежний. */
  readonly spaceId: string | null;
}

export function resolveClaimPartition(
  auth: Pick<MemoryAuthorization, "familyId" | "groupId" | "space" | "userId">,
  scope: MemoryScope,
): ClaimPartition {
  const spaceId = validatedMemorySpace(auth.space)?.spaceId ?? null;
  if (scope === "personal" && auth.userId) return { scopePartitionKey: auth.userId, spaceId };
  if (scope === "group" && auth.groupId) return { scopePartitionKey: auth.groupId, spaceId };
  if (scope === "family") return { scopePartitionKey: auth.familyId, spaceId };
  throw new AppError(
    "AGENT_MEMORY_CONTEXT_INVALID",
    "Не удалось определить область для записи памяти",
  );
}
