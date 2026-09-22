/** Locking an existing planner record and changing its status inside the caller's transaction. */
import type { PoolClient } from "pg";
import { AppError } from "./app-error.js";
import { currentTimeRepository } from "./current-time-repository.js";
import type { MemoryAuthorization, MemoryScope } from "./memory-context.js";
import { nextSharedTaskStatus, type SharedTaskInput } from "./shared-tasks.js";
import { denied, readTasks, type TaskRow } from "./shared-task-access.js";
import { recordTaskVersion } from "./shared-task-handover.js";
import { advanceRecurringTask } from "./shared-task-recurrence.js";
import { requireTaskRecordAction, taskSpaceAction } from "./spaces/task-space-action.js";

/** Действия, которые меняют только состояние дела и потому допустимы в пакете. */
export const STATUS_ACTIONS = ["claim", "accept", "decline", "complete", "cancel", "reopen"] as const;
export type StatusAction = typeof STATUS_ACTIONS[number];

/** Видимость, право области и версия проверяются до блокировки строки, как у любого изменения. */
export async function lockTaskForChange(
  client: PoolClient, auth: MemoryAuthorization, scope: MemoryScope, input: SharedTaskInput,
): Promise<TaskRow> {
  const {rows} = await readTasks(client, auth, scope, input.id!);
  if (!rows[0]) denied();
  const expectedVersion=await requireTaskRecordAction(client,auth,input.id!,taskSpaceAction(input));
  const locked = await client.query<TaskRow>(`SELECT *,due_on::text,recurrence_anchor_on::text AS recurrence_anchor_on
     FROM shared_tasks WHERE id=$1 FOR UPDATE`, [input.id]);
  const task = locked.rows[0];
  if (!task) denied();
  // Версия из запроса, если передана, должна совпасть: дело могли изменить после прочтения.
  if(task.version!==expectedVersion || (input.version !== undefined && input.version !== task.version)) {
    throw new AppError("AGENT_TASK_VERSION_CONFLICT","Задача изменилась. Прочитайте её заново");
  }
  return task;
}

export async function applyTaskStatus(
  client: PoolClient, auth: MemoryAuthorization, task: TaskRow, action: StatusAction,
): Promise<void> {
  if (task.kind !== "task" && action !== "cancel" && action !== "reopen") denied();
  const status = nextSharedTaskStatus(task.status, action,
    task.assignee_telegram_id === auth.telegramUserId, task.creator_telegram_id === auth.telegramUserId);
  // Исполнитель появляется ровно один раз и только у свободного дела: строка уже под
  // блокировкой, поэтому второй «беру» видит занятое дело, а не переписывает его.
  await client.query(
    `UPDATE shared_tasks SET status=$2, version=version+1, updated_at=now(),
        assignee_telegram_id = CASE WHEN $3::text IS NULL THEN assignee_telegram_id ELSE $3 END,
        -- Закрытое дело не ждёт ответа о передаче: запрос снимается тем же оператором,
        -- иначе схема справедливо не принимает строку «закрыто, но кому-то предложено».
        pending_assignee_telegram_id = CASE WHEN $4::boolean THEN NULL ELSE pending_assignee_telegram_id END,
        transfer_requested_at = CASE WHEN $4::boolean THEN NULL ELSE transfer_requested_at END
      WHERE id=$1`,
    [task.id, status, action === "claim" ? auth.telegramUserId : null,
      ["cancelled", "completed", "declined"].includes(status)],
  );
  await recordTaskVersion(client, task, action, auth.telegramUserId!);
  if (task.status === 'proposed' && status !== 'proposed') {
    // An answered request retires a not-yet-started lease without reporting an outage.
    // A send whose durable marker already exists may finish; completion will pause it.
    await client.query(`UPDATE reminders SET status='paused',updated_at=now(),
      lease_token=NULL,lease_expires_at=NULL,dispatch_started_at=NULL,last_error_code=NULL
      WHERE shared_task_id=$1 AND task_reminder_kind='response'
        AND (status IN ('active','failed') OR (status='leased' AND dispatch_started_at IS NULL))`,[task.id]);
  }
  // Закрытие вхождения повторяющегося дела не закрывает будущие: оно получает новую дату.
  if (status === "completed" && task.recurrence_unit !== null) {
    await client.query("UPDATE shared_tasks SET status='accepted' WHERE id=$1", [task.id]);
    await advanceRecurringTask(client, task, {
      actorTelegramId: auth.telegramUserId!,
      timezone: await currentTimeRepository.findTurnTimezone(auth.userId, auth.familyId) ?? "UTC",
    });
  }
  // Закрытое вхождение повторяющегося дела не заканчивает само дело, поэтому и сигнал у
  // него не заканчивается: он живёт своим расписанием до следующего срока.
  const taskEnded = ["completed","cancelled","declined"].includes(status)
    && !(status === "completed" && task.recurrence_unit !== null);
  if (taskEnded) {
    // A send already in flight may finish; all future signals are paused.
    await client.query("UPDATE reminders SET status='paused',updated_at=now() WHERE shared_task_id=$1 AND status IN ('active','failed')",[task.id]);
  }
  // Возвращённое в работу дело возвращает свой сигнал, но только тот, чьё время ещё впереди:
  // старый сигнал закрытого дела остаётся на паузе (история T05), а будущий иначе молчал бы
  // навсегда, хотя человек считает, что напоминание осталось.
  if (action === "reopen") {
    await client.query(
      `UPDATE reminders SET status='active',updated_at=now()
        WHERE shared_task_id=$1 AND status='paused' AND available_at > now()`,
      [task.id],
    );
  }
}
