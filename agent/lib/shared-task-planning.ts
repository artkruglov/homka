/** Planning and reflection do not silently create deadlines or somebody else's obligations. */
import type { PoolClient } from "pg";
import { AppError } from "./app-error.js";
import type { MemoryAuthorization } from "./memory-context.js";
import type { SharedTaskInput } from "./shared-tasks.js";
import { denied, type TaskRow } from "./shared-task-access.js";
import { recordTaskVersion } from "./shared-task-handover.js";

export async function mutateTaskPlan(client:PoolClient,auth:MemoryAuthorization,task:TaskRow,input:SharedTaskInput) {
  const actor=auth.telegramUserId!;
  if (["completed","cancelled","declined"].includes(task.status)) {
    throw new AppError("AGENT_TASK_CLOSED","Эта запись закрыта. Создайте новое дело при необходимости");
  }
  if (input.action === "record") {
    if (task.kind !== "ritual") denied();
    await client.query(`INSERT INTO shared_ritual_occurrences(task_id,actor_telegram_id,occurred_on,note)
      VALUES($1,$2,$3,$4) ON CONFLICT(task_id,actor_telegram_id,occurred_on)
      DO UPDATE SET note=excluded.note`,[task.id,actor,input.occurredOn,input.note]);
    return;
  }
  if (input.action === "plan" || input.action === "unplan") {
    if (task.kind === "task" && task.assignee_telegram_id !== null &&
      (task.assignee_telegram_id !== actor || task.status !== "accepted")) denied();
    if (input.action === "unplan") {
      await client.query("DELETE FROM shared_task_plans WHERE task_id=$1 AND telegram_user_id=$2",[task.id,actor]);
    } else {
      await client.query(`INSERT INTO shared_task_plans(task_id,telegram_user_id,planned_from,planned_until)
        VALUES($1,$2,$3,$4) ON CONFLICT(task_id,telegram_user_id) DO UPDATE
        SET planned_from=excluded.planned_from,planned_until=excluded.planned_until,updated_at=now()`,
      [task.id,actor,input.plannedFrom,input.plannedUntil]);
    }
    return;
  }
  if (task.version !== input.version) throw new AppError("AGENT_TASK_VERSION_CONFLICT","Запись уже изменилась. Прочитайте её заново перед правкой");
  if (input.action === "clarify" && (task.kind === "ritual" || task.status === "proposed")) denied();
  // An author cannot rewrite a task accepted by another participant.
  // The repository has already proved visibility. An open task is clarified together;
  // claiming it restores the assignee's exclusive editing right.
  if (task.assignee_telegram_id !== null && task.assignee_telegram_id !== actor) denied();
  if (input.action === "activate") {
    if (task.kind !== "idea") denied();
    await client.query("UPDATE shared_tasks SET kind='task',version=version+1,updated_at=now() WHERE id=$1",[task.id]);
  } else {
    const dueAt=input.dueAt === undefined ? task.due_at : input.dueAt;
    const dueOn=input.dueOn === undefined ? task.due_on : input.dueOn;
    if ((dueAt && dueOn) || task.kind !== "task" && (dueAt || dueOn)) {
      throw new AppError("AGENT_TASK_DEADLINE_INVALID","Идеи и традиции без срока; у задачи выберите дату или точное время");
    }
    await client.query(`UPDATE shared_tasks SET title=$2,details=$3,list_name=$4,due_at=$5,due_on=$6,
      version=version+1,updated_at=now() WHERE id=$1`,[task.id,input.title ?? task.title,
      input.details === undefined ? task.details : input.details,
      input.listName === undefined ? task.list_name : input.listName,dueAt,dueOn]);
    // Linked notifications describe the same task, never stale or private appended notes.
    if (input.title !== undefined) await client.query("UPDATE reminders SET content=$2,updated_at=now() WHERE shared_task_id=$1 AND status='active'",[task.id,input.title]);
  }
  await recordTaskVersion(client, task, input.action, actor);
}
