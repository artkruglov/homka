/**
 * Передача ответственности и отказ от неё.
 *
 * Экспорт:
 * - `recordTaskVersion`: снимок прежнего состояния при любом переходе.
 * - `applyTaskHandover`: передача, её принятие, отказ получателя и отказ исполнителя.
 *
 * До согласия получателя ответственным остаётся прежний исполнитель: запрос передачи ничего не
 * меняет, кроме видимого ожидания. Отказ самого исполнителя не назначает никого автоматически —
 * дело становится свободным, и отсутствие ответственного видно всей области.
 *
 * Снимок прежнего состояния пишется на каждом переходе: у передачи иначе не было бы того, к чему
 * возвращаться, а история дела обрывалась бы на любом «принял» или «сделал».
 */
import type { PoolClient } from "pg";

import { AppError } from "./app-error.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { denied, type TaskRow } from "./shared-task-access.js";
import type { SharedTaskInput } from "./shared-tasks.js";

export async function recordTaskVersion(
  client: PoolClient,
  task: TaskRow,
  action: string,
  actorTelegramId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO shared_task_versions(task_id,version,actor_telegram_id,action,previous_record)
     VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT (task_id,version) DO NOTHING`,
    [task.id, task.version + 1, actorTelegramId, action, JSON.stringify(task)],
  );
}

interface HandoverInput {
  auth: MemoryAuthorization;
  client: PoolClient;
  input: SharedTaskInput;
  recipient: string | null;
  task: TaskRow;
}

export async function applyTaskHandover(handover: HandoverInput): Promise<void> {
  const { auth, client, input, recipient, task } = handover;
  // У личного дела хозяин один и тот же человек, и это инвариант схемы, а не привычка: передавать
  // и отпускать там некому, а попытка сделать это оставила бы дело без исполнителя.
  if (task.scope === "personal") {
    throw new AppError(
      "AGENT_TASK_PERSONAL_HANDOVER",
      "Личное дело нельзя передать или отпустить: оно всегда остаётся вашим",
    );
  }
  const actor = auth.telegramUserId!;
  const isAssignee = task.assignee_telegram_id === actor;
  const isRecipient = task.pending_assignee_telegram_id === actor;

  if (input.action === "transfer") {
    if (!isAssignee || task.status !== "accepted" || task.version !== input.version) {
      throw new AppError(
        "AGENT_TASK_TRANSITION_DENIED",
        "Передать можно только своё принятое дело и с актуальной version",
      );
    }
    if (recipient === null || recipient === actor) denied();
    // Ответственность не переходит сейчас: до согласия она остаётся на том, кто передаёт.
    await client.query(
      `UPDATE shared_tasks SET pending_assignee_telegram_id=$2, transfer_requested_at=now(),
          version=version+1, updated_at=now() WHERE id=$1`,
      [task.id, recipient],
    );
    return;
  }
  if (input.action === "release") {
    if (!isAssignee || task.status !== "accepted" || task.version !== input.version) {
      throw new AppError(
        "AGENT_TASK_TRANSITION_DENIED",
        "Отказаться можно от своего принятого дела и с актуальной version",
      );
    }
    // Отсутствие ответственного видно всем: дело возвращается в свободные, а не исчезает.
    await client.query(
      `UPDATE shared_tasks SET assignee_telegram_id=NULL, status='open',
          pending_assignee_telegram_id=NULL, transfer_requested_at=NULL,
          version=version+1, updated_at=now() WHERE id=$1`,
      [task.id],
    );
    return;
  }
  if (task.pending_assignee_telegram_id === null) {
    throw new AppError("AGENT_TASK_TRANSFER_ABSENT", "У этого дела нет запроса передачи");
  }
  if (input.action === "accept_transfer") {
    // Принимает только тот, кому передают: молчание других ничего не решает.
    if (!isRecipient) denied();
    await client.query(
      `UPDATE shared_tasks SET assignee_telegram_id=pending_assignee_telegram_id,
          pending_assignee_telegram_id=NULL, transfer_requested_at=NULL,
          version=version+1, updated_at=now() WHERE id=$1`,
      [task.id],
    );
    return;
  }
  // Отказаться от передачи может и получатель, и тот, кто её предложил.
  if (!isRecipient && !isAssignee) denied();
  await client.query(
    `UPDATE shared_tasks SET pending_assignee_telegram_id=NULL, transfer_requested_at=NULL,
        version=version+1, updated_at=now() WHERE id=$1`,
    [task.id],
  );
}
