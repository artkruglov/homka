/** Durable tasks: verified actors, exact chat visibility and assignee-only acceptance. */
import { createHash } from "node:crypto";
import { AppError } from "./app-error.js";
import { currentTimeRepository } from "./current-time-repository.js";
import { database } from "./database.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { sharedTaskInput, type SharedTaskInput } from "./shared-tasks.js";
import { authorize, denied, listNames, participants, present, presentSummary, readTasks } from "./shared-task-access.js";
import { applyTaskHandover, recordTaskVersion } from "./shared-task-handover.js";
import { executeTaskBatch } from "./shared-task-batch.js";
import { createTask } from "./shared-task-create.js";
import { applyTaskStatus, lockTaskForChange, type StatusAction } from "./shared-task-transition.js";
import { mutateTaskPlan } from "./shared-task-planning.js";
import { requireSpaceAction } from "./spaces/space-write.js";
import { taskSpaceAction,requireTaskRecipientSpace,lockTaskSpaceBoundary } from "./spaces/task-space-action.js";
import { isCurrentTelegramMember } from "./telegram-current-membership.js";

export const sharedTaskRepository = {
  async execute(auth: MemoryAuthorization, raw: SharedTaskInput, operationKey: string) {
    const parsed = sharedTaskInput.safeParse(raw);
    if (!parsed.success) throw new AppError("AGENT_TASK_INPUT_INVALID", "Проверьте действие и поля задачи");
    const input = parsed.data;
    if (input.action === "batch") {
      const batch = await executeTaskBatch(auth, input, operationKey);
      return { tasks: batch.tasks, replayed: batch.replayed };
    }
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      if(input.id) await lockTaskSpaceBoundary(client,auth.familyId,input.id);
      // Родительское пространство блокируется раньше живых проверок членства и группы.
      const spaceId = await requireSpaceAction(client, {
        chatType: auth.groupId === null ? "private" : "supergroup",
        familyId: auth.familyId,
        groupId: auth.groupId,
        ...(auth.space ? { space: auth.space } : {}),
        userId: auth.userId,
      }, input.action === "create" ? taskSpaceAction(input) : "read");
      const scope = await authorize(client, auth);
      if (input.action === "participants") {
        const result = await participants(client, auth, scope);
        await client.query("COMMIT");
        return { participants: result };
      }
      if (input.action === "lists") {
        const lists = await listNames(client, auth, scope);
        await client.query("COMMIT");
        return { lists };
      }
      if (input.action === "list") {
        // День человека считается в его поясе: полночь по UTC для Москвы наступает в три ночи.
        const timezone = input.view === "today"
          ? await currentTimeRepository.findTurnTimezone(auth.userId, auth.familyId) ?? "UTC"
          : "UTC";
        const result = await readTasks(client, auth, scope, null, input, timezone);
        await client.query("COMMIT");
        return { tasks: result.rows.map(row=>presentSummary(row,!auth.groupId)),
          nextCursor:result.nextCursor, truncated:Boolean(result.nextCursor), incomplete:result.incomplete };
      }
      if (input.action === "get") {
        const {rows}=await readTasks(client,auth,scope,input.id!);
        if (!rows[0]) denied();
        await client.query("COMMIT");
        return { task: present(rows[0],!auth.groupId), replayed: false };
      }
      if (input.action === "history") {
        const {rows}=await readTasks(client,auth,scope,input.id!);
        if (!rows[0] || rows[0].kind !== "ritual") denied();
        const history=await client.query("SELECT actor_telegram_id,occurred_on::text,note FROM shared_ritual_occurrences WHERE task_id=$1 ORDER BY occurred_on DESC,id DESC LIMIT 50",[input.id]);
        await client.query("COMMIT");
        return {occurrences:history.rows};
      }
      if (!operationKey || operationKey.length > 500) denied();
      const hash = createHash("sha256").update(JSON.stringify({ input, actor: auth.telegramUserId,
        group: auth.groupId, scope })).digest("hex");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${auth.familyId}:${operationKey}`]);
      const previous = await client.query<{ request_hash: string; task_id: string }>(
        "SELECT request_hash,task_id FROM shared_task_operations WHERE family_id=$1 AND operation_key=$2",
        [auth.familyId, operationKey],
      );
      if (previous.rows[0]) {
        if (previous.rows[0].request_hash !== hash) denied();
        const {rows} = await readTasks(client, auth, scope, previous.rows[0].task_id);
        if (!rows[0]) denied();
        await client.query("COMMIT");
        return { task: present(rows[0],!auth.groupId), replayed: true };
      }
      let id: string;
      if (input.action === "create") {
        id = await createTask(client, auth, scope, spaceId, input);
      } else {
        const task = await lockTaskForChange(client, auth, scope, input);
        if (["update","clarify","plan","unplan","activate","record"].includes(input.action)) {
          await mutateTaskPlan(client,auth,task,input);
        } else if (["transfer","accept_transfer","decline_transfer","release"].includes(input.action)) {
          // Передача и отказ меняют исполнителя, а не состояние, поэтому идут своим путём.
          let recipient: string | null = null;
          if (input.action === "transfer") {
            await participants(client, auth, scope);
            // Список участников пополняется из семьи и никогда не чистится, поэтому членство
            // проверяется здесь так же, как при создании: иначе дело повисло бы на ушедшем.
            recipient = (await client.query<{ telegram_user_id: string }>(
              `SELECT p.telegram_user_id FROM shared_task_participants p
                WHERE p.id=$1 AND p.family_id=$2 AND p.group_id IS NOT DISTINCT FROM $3::uuid
                AND ($3::uuid IS NOT NULL OR EXISTS (SELECT 1 FROM users u JOIN family_memberships m ON m.user_id=u.id
                  WHERE m.family_id=$2 AND u.telegram_user_id=p.telegram_user_id))`,
              [input.assigneeRef, auth.familyId, scope === "group" ? auth.groupId : null],
            )).rows[0]?.telegram_user_id ?? null;
            if (recipient !== null && scope === "group") {
              const destination = await client.query<{ telegram_chat_id: string }>(
                "SELECT telegram_chat_id FROM telegram_groups WHERE id=$1 AND family_id=$2",
                [auth.groupId, auth.familyId],
              );
              if (!destination.rows[0] || !await isCurrentTelegramMember(destination.rows[0].telegram_chat_id, recipient)) denied();
            }
          }
          if(input.action === "transfer") await requireTaskRecipientSpace(client,auth,task.space_id,recipient);
          await recordTaskVersion(client, task, input.action, auth.telegramUserId!);
          await applyTaskHandover({ auth, client, input, recipient, task });
        } else {
          await applyTaskStatus(client, auth, task, input.action as StatusAction);
        }
        id = task.id;
      }
      await client.query(
        "INSERT INTO shared_task_operations(family_id,operation_key,actor_telegram_id,request_hash,task_id) VALUES($1,$2,$3,$4,$5)",
        [auth.familyId, operationKey, auth.telegramUserId, hash, id],
      );
      await client.query(
        `INSERT INTO audit_events(family_id,actor_user_id,event_type,subject_id,metadata)
         VALUES($1,$2,'shared_task.' || $3::text,$4,jsonb_build_object('telegramActorId',$5::text,'scope',$6::text))`,
        [auth.familyId, auth.userId, input.action, id, auth.telegramUserId, scope],
      );
      const {rows} = await readTasks(client, auth, scope, id);
      if (!rows[0]) denied();
      await client.query("COMMIT");
      return { task: present(rows[0],!auth.groupId), replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  },
};
