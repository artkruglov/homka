/**
 * Several planner changes in one call, all or nothing.
 *
 * Exports:
 * - `executeTaskBatch`: creates and closes tasks of one message in a single transaction.
 *
 * Список из сообщения раньше требовал по вызову на дело: шесть пунктов — шесть шагов модели,
 * и на проде ход из 22 шагов так и не дошёл до закрытия. Пакет проходит те же проверки, что и
 * одиночный вызов, по каждому элементу. Отказ любого пункта откатывает весь пакет: частичный
 * коммит сделал бы повтор неоднозначным, а ошибка пункта почти всегда означает неверно
 * выбранное дело, и правильный ответ на неё — исправить выбор или спросить человека.
 */
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { AppError, isAppError } from "./app-error.js";
import { database } from "./database.js";
import type { MemoryAuthorization, MemoryScope } from "./memory-context.js";
import type { SharedTaskInput } from "./shared-tasks.js";
import { authorize, denied, present, readTasks } from "./shared-task-access.js";
import { createTask } from "./shared-task-create.js";
import { mutateTaskPlan } from "./shared-task-planning.js";
import { applyTaskStatus, lockTaskForChange, STATUS_ACTIONS, type StatusAction } from "./shared-task-transition.js";
import { requireSpaceAction } from "./spaces/space-write.js";
import { lockTaskSpaceBoundary, taskSpaceAction } from "./spaces/task-space-action.js";

async function readInOrder(client: PoolClient, auth: MemoryAuthorization, scope: MemoryScope, ids: readonly string[]) {
  const { rows } = await readTasks(client, auth, scope, ids);
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => {
    const row = byId.get(id);
    if (!row) denied();
    return present(row, !auth.groupId);
  });
}

/**
 * Изменения идут в порядке id, создания после них: два пакета над одними делами берут строки в
 * одном порядке и не ждут друг друга по кругу. Ответ возвращается в порядке пунктов.
 */
function executionOrder(items: readonly SharedTaskInput[]) {
  const indexed = items.map((item, index) => ({ item, index }));
  const changes = indexed.filter(({ item }) => item.id).sort((a, b) => a.item.id!.localeCompare(b.item.id!));
  return [...changes, ...indexed.filter(({ item }) => !item.id)];
}

export async function executeTaskBatch(auth: MemoryAuthorization, input: SharedTaskInput, operationKey: string) {
  const items = (input.items ?? []) as SharedTaskInput[];
  const keys = items.map((_, index) => `${operationKey}#${index}`);
  if (!operationKey || items.length === 0 || keys.some((key) => key.length > 500)) denied();
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    // Граница области берётся раньше живых проверок группы и членства, как у одиночного вызова.
    for (const id of items.flatMap((item) => item.id ? [item.id] : []).sort()) {
      await lockTaskSpaceBoundary(client, auth.familyId, id);
    }
    const request = {
      chatType: auth.groupId === null ? "private" as const : "supergroup" as const,
      familyId: auth.familyId,
      groupId: auth.groupId,
      ...(auth.space ? { space: auth.space } : {}),
      userId: auth.userId,
    };
    let spaceId: string | null = null;
    const actions = new Set(items.map((item) => item.action === "create" ? taskSpaceAction(item) : "read" as const));
    for (const action of actions) spaceId = await requireSpaceAction(client, request, action);
    const scope = await authorize(client, auth);
    const hash = createHash("sha256").update(JSON.stringify({ input, actor: auth.telegramUserId,
      group: auth.groupId, scope })).digest("hex");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${auth.familyId}:${operationKey}`]);
    const previous = await client.query<{ operation_key: string; request_hash: string; task_id: string }>(
      "SELECT operation_key,request_hash,task_id FROM shared_task_operations WHERE family_id=$1 AND operation_key=ANY($2)",
      [auth.familyId, keys],
    );
    if (previous.rows.length > 0) {
      if (previous.rows.length !== keys.length || previous.rows.some((row) => row.request_hash !== hash)) denied();
      const taskByKey = new Map(previous.rows.map((row) => [row.operation_key, row.task_id]));
      const tasks = await readInOrder(client, auth, scope, keys.map((key) => taskByKey.get(key)!));
      await client.query("COMMIT");
      return { applied: tasks.length, note: "Пакет применён целиком. Не повторяй его пункты по одному", tasks, replayed: true };
    }
    const taskIds: string[] = [];
    const failures: { index: number; code: string }[] = [];
    for (const { item, index } of executionOrder(items)) {
      // Точка сохранения на пункт: отказ одного не прерывает проверку остальных, и модель узнаёт
      // обо всех неверных пунктах сразу, а не по одному за вызов.
      await client.query("SAVEPOINT task_batch_item");
      try {
        if (item.action === "create") {
          taskIds[index] = await createTask(client, auth, scope, spaceId, item);
        } else {
          const task = await lockTaskForChange(client, auth, scope, item);
          // Правка, план и отметка традиции идут тем же путём, что и в одиночном вызове: пакет
          // не знает о них ничего своего и потому не может разойтись с ним в правах.
          if ((STATUS_ACTIONS as readonly string[]).includes(item.action)) {
            await applyTaskStatus(client, auth, task, item.action as StatusAction);
          } else {
            await mutateTaskPlan(client, auth, task, item);
          }
          taskIds[index] = task.id;
        }
        await client.query("RELEASE SAVEPOINT task_batch_item");
      } catch (error) {
        if (!isAppError(error)) throw error;
        await client.query("ROLLBACK TO SAVEPOINT task_batch_item");
        failures.push({ index, code: error.code });
      }
    }
    if (failures.length > 0) {
      const named = failures.sort((a, b) => a.index - b.index).map((f) => `#${f.index + 1} ${f.code}`).join("; ");
      throw new AppError("AGENT_TASK_BATCH_REJECTED",
        `Пакет не применён, ничего не изменено. Не прошли пункты: ${named}. Исправьте их или спросите человека`);
    }
    for (const [index, item] of items.entries()) {
      await client.query(
        "INSERT INTO shared_task_operations(family_id,operation_key,actor_telegram_id,request_hash,task_id) VALUES($1,$2,$3,$4,$5)",
        [auth.familyId, keys[index], auth.telegramUserId, hash, taskIds[index]],
      );
      await client.query(
        `INSERT INTO audit_events(family_id,actor_user_id,event_type,subject_id,metadata)
         VALUES($1,$2,'shared_task.' || $3::text,$4,
           jsonb_build_object('telegramActorId',$5::text,'scope',$6::text,'batch',$7::text))`,
        [auth.familyId, auth.userId, item.action, taskIds[index], auth.telegramUserId, scope, operationKey],
      );
    }
    const tasks = await readInOrder(client, auth, scope, taskIds);
    await client.query("COMMIT");
    // Эвал 23 сентября: собрав верный пакет из трёх закрытий, модель в половине сэмплов повторила
    // те же три поодиночке. Ответ говорит, что делать больше нечего, прямо в точке решения:
    // в описании инструмента этой строке места нет, а повтор на проде стоил бы трёх отказов.
    return { applied: tasks.length, note: "Пакет применён целиком. Не повторяй его пункты по одному", tasks, replayed: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
