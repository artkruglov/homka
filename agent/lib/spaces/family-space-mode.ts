/**
 * Явное состояние режима пространств у семьи.
 *
 * Экспорт:
 * - `FamilySpaceMode`: прежний режим или включённые пространства.
 * - `readFamilySpaceMode`: текущий режим семьи.
 *
 * Режим читается заново на каждом обращении и никогда не кэшируется в процессе: снятие режима
 * обязано действовать сразу, без перезапуска контейнеров. Тем, кому нужна линеаризация с самим
 * переключением, читать его в той же транзакции, где берётся блокировка пространства.
 */
import type { PoolClient } from "pg";

export type FamilySpaceMode = "legacy" | "spaces";

export async function readFamilySpaceMode(
  client: PoolClient,
  familyId: string,
): Promise<FamilySpaceMode> {
  const result = await client.query<{ mode: FamilySpaceMode }>(
    "SELECT mode FROM family_space_runtime WHERE family_id = $1",
    [familyId],
  );
  // Строку заводит триггер на каждую новую семью, поэтому её отсутствие означает, что семьи нет.
  return result.rows[0]?.mode ?? "legacy";
}
