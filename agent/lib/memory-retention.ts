/**
 * Physical cleanup of softly deleted memory.
 *
 * Export:
 * - `purgeSoftDeletedMemory`: removes rows whose recovery window has elapsed.
 *
 * Key constructs:
 * - Удаление факта мягкое, поэтому строка ещё существует и восстановима. Физическая уборка идёт
 *   только по базовой таблице: представление `memory_items` таких строк не показывает вовсе.
 * - Каскады базовой таблицы уносят чанки эмбеддингов и связанные заявления, поэтому отдельного
 *   обхода зависимостей здесь нет.
 */
import {
  MEMORY_SOFT_DELETE_PURGE_BATCH_SIZE,
  MEMORY_SOFT_DELETE_RETENTION_DAYS,
} from "../config.js";
import { database } from "./database.js";

export async function purgeSoftDeletedMemory(now: Date): Promise<number> {
  const result = await database().query(
    `WITH expired AS (
       SELECT id
         FROM memory_items_all
        WHERE deleted_at IS NOT NULL
          AND deleted_at <= $1::timestamptz - ($2::integer * interval '1 day')
        ORDER BY deleted_at
        LIMIT $3::integer
        FOR UPDATE SKIP LOCKED
     )
     DELETE FROM memory_items_all item
      USING expired
      WHERE item.id = expired.id`,
    [now, MEMORY_SOFT_DELETE_RETENTION_DAYS, MEMORY_SOFT_DELETE_PURGE_BATCH_SIZE],
  );
  const deletedCount = result.rowCount ?? 0;
  if (deletedCount > 0) {
    console.info(JSON.stringify({
      code: "AGENT_MEMORY_PURGE_COMPLETED",
      deletedCount,
      batchLimitReached: deletedCount === MEMORY_SOFT_DELETE_PURGE_BATCH_SIZE,
    }));
  }
  return deletedCount;
}
