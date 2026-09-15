/**
 * Запас места и рост базы.
 *
 * Экспорт:
 * - `StorageHeadroom`: свободное место файловой системы и размер базы.
 * - `readStorageHeadroom`: снимок на сейчас.
 * - `formatStorageHeadroom`: строка для дайджеста либо `null`, когда сообщать нечего.
 *
 * Откат требует места под две копии дампа плюс образы, а обнаруживался кончившийся диск человеком
 * и обычно уже после того, как что-то перестало писаться. Место видно изнутри контейнера: тома
 * Docker лежат на той же файловой системе, что и его корень, и `statfs` говорит о ней правду.
 *
 * Размер базы читается запросом, а не оценкой по файлам: `pg_database_size` это то же число, по
 * которому считается место под дамп.
 *
 * Порог назван в долях, а не в гигабайтах: на разных установках диск разный, а «меньше пятой
 * части свободно» значит одно и то же. В тихий день строка не печатается: дайджест не должен
 * каждое утро напоминать, что всё в порядке.
 */
import { statfs } from "node:fs/promises";

export const STORAGE_HEADROOM_WARNING_FRACTION = 0.2;

export interface StorageHeadroom {
  readonly databaseBytes: number | null;
  readonly freeBytes: number | null;
  readonly totalBytes: number | null;
}

function gigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} ГиБ`;
}

/**
 * Строка для дайджеста. Печатается, когда свободного места мало либо когда база заняла больше
 * места, чем осталось свободно: с этого момента откат перестаёт помещаться на диск.
 */
export function formatStorageHeadroom(headroom: StorageHeadroom): string | null {
  const { databaseBytes, freeBytes, totalBytes } = headroom;
  if (freeBytes === null || totalBytes === null || totalBytes === 0) return null;
  const fraction = freeBytes / totalBytes;
  const tight = fraction < STORAGE_HEADROOM_WARNING_FRACTION;
  const dumpDoesNotFit = databaseBytes !== null && databaseBytes * 2 > freeBytes;
  if (!tight && !dumpDoesNotFit) return null;
  const percent = Math.round(fraction * 100);
  const database = databaseBytes === null ? "" : `, база ${gigabytes(databaseBytes)}`;
  return [
    `Диск: свободно ${gigabytes(freeBytes)} из ${gigabytes(totalBytes)} (${percent} %)${database}.`,
    dumpDoesNotFit
      ? "Две копии дампа уже не помещаются: откат требует места, освободите его заранее."
      : "Места мало: откату нужны две копии дампа плюс образы.",
  ].join(" ");
}

/**
 * Снимок на сейчас. Обе величины независимы: недоступная файловая система не мешает узнать
 * размер базы, а недоступная база — размер диска. Сбой любой из них не срывает дайджест, потому
 * что дайджест существует ради того, чтобы приходить.
 */
export async function readStorageHeadroom(
  databaseSize: () => Promise<number | null>,
  path = "/",
): Promise<StorageHeadroom> {
  const [space, databaseBytes] = await Promise.all([
    statfs(path).then(
      (stats) => ({
        freeBytes: Number(stats.bavail) * Number(stats.bsize),
        totalBytes: Number(stats.blocks) * Number(stats.bsize),
      }),
      (error: unknown) => {
        console.error(JSON.stringify({
          code: "AGENT_STORAGE_HEADROOM_UNREADABLE",
          error: error instanceof Error ? error.message : String(error),
        }));
        return { freeBytes: null, totalBytes: null };
      },
    ),
    databaseSize().catch((error: unknown) => {
      console.error(JSON.stringify({
        code: "AGENT_DATABASE_SIZE_UNREADABLE",
        error: error instanceof Error ? error.message : String(error),
      }));
      return null;
    }),
  ]);
  return { databaseBytes, ...space };
}
