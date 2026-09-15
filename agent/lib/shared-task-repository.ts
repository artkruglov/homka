/** Durable tasks: verified actors, exact chat visibility and assignee-only acceptance. */
import { createHash } from "node:crypto";
import { AppError } from "./app-error.js";
import { currentTimeRepository } from "./current-time-repository.js";
import { database } from "./database.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { nextSharedTaskStatus, sharedTaskInput, type SharedTaskInput } from "./shared-tasks.js";
import { authorize, denied, listNames, participants, present, readTasks, type TaskRow } from "./shared-task-access.js";
import { applyTaskHandover, recordTaskVersion } from "./shared-task-handover.js";
import { advanceRecurringTask } from "./shared-task-recurrence.js";
import { mutateTaskPlan } from "./shared-task-planning.js";
import { personalTimeRepository } from "./personal-time/personal-time-repository.js";
import { requireSpaceAction } from "./spaces/space-write.js";
import { taskSpaceAction,requireTaskRecordAction,requireTaskRecipientSpace,lockTaskSpaceBoundary } from "./spaces/task-space-action.js";
import { isCurrentTelegramMember } from "./telegram-current-membership.js";
import { CARE_AREA_VISIBILITY, careAreaSpaceValues } from "./care-areas/care-area-access.js";

export const sharedTaskRepository = {
  async execute(auth: MemoryAuthorization, raw: SharedTaskInput, operationKey: string) {
    const parsed = sharedTaskInput.safeParse(raw);
    if (!parsed.success) throw new AppError("AGENT_TASK_INPUT_INVALID", "Проверьте действие и поля задачи");
    const input = parsed.data;
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
        return { tasks: result.rows.map(row=>present(row,!auth.groupId)),
          nextCursor:result.nextCursor, truncated:Boolean(result.nextCursor), incomplete:result.incomplete };
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
        // Свободное дело не назначается автору: вопрос «кто возьмёт» задают всей области, а взять
        // его может только тот, кто эту область читает. В личной области брать некому.
        if (input.unassigned && scope === "personal") denied();
        let assignee: string | null = input.unassigned ? null : auth.telegramUserId!;
        if (input.assigneeRef) {
          if (scope === "personal") denied();
          await participants(client, auth, scope);
          const result = await client.query<{ telegram_user_id: string }>(
            `SELECT p.telegram_user_id FROM shared_task_participants p
             WHERE p.id=$1 AND p.family_id=$2 AND p.group_id IS NOT DISTINCT FROM $3::uuid
             AND ($3::uuid IS NOT NULL OR EXISTS (SELECT 1 FROM users u JOIN family_memberships m ON m.user_id=u.id
               WHERE m.family_id=$2 AND u.telegram_user_id=p.telegram_user_id))`,
            [input.assigneeRef, auth.familyId, scope === "group" ? auth.groupId : null],
          );
          if (!result.rows[0]) denied();
          assignee = result.rows[0].telegram_user_id;
          if (scope === "group" && assignee !== auth.telegramUserId) {
            const destination = await client.query<{ telegram_chat_id: string }>(
              "SELECT telegram_chat_id FROM telegram_groups WHERE id=$1 AND family_id=$2",
              [auth.groupId, auth.familyId],
            );
            if (!destination.rows[0] || !await isCurrentTelegramMember(destination.rows[0].telegram_chat_id, assignee)) denied();
          }
        }
        // Дело области заботы предлагается тому, кто её ведёт: это следствие принятой области, а
        // не новое назначение, и получатель всё равно принимает его сам.
        let careAreaId: string | null = null;
        if (input.careAreaRef) {
          if (scope === "personal") denied();
          const area = (await client.query<{ id: string; owner_telegram_id: string | null }>(
            `SELECT area.id, area.owner_telegram_id FROM care_areas area
              WHERE area.id=$1 AND area.family_id=$2 AND area.scope=$3 AND area.group_id IS NOT DISTINCT FROM $4::uuid
                AND area.status <> 'retired' AND ${CARE_AREA_VISIBILITY}
                AND ($5::uuid IS NULL OR area.space_id=$5::uuid) FOR SHARE`,
            [input.careAreaRef, auth.familyId, scope === "group" ? "group" : "family",
              scope === "group" ? auth.groupId : null, ...careAreaSpaceValues(auth)],
          )).rows[0];
          if (!area) denied();
          careAreaId = area.id;
          if (!input.assigneeRef && !input.unassigned && area.owner_telegram_id !== null) {
            assignee = area.owner_telegram_id;
          }
        }
        await requireTaskRecipientSpace(client,auth,spaceId,assignee);
        // Личное время чужое: поставить на него дело нельзя, и отказ называет окно, чтобы не
        // пришлось объясняться самому человеку.
        if (assignee !== null && assignee !== auth.telegramUserId && input.dueAt) {
          const busy = await personalTimeRepository.conflictFor(assignee, new Date(input.dueAt));
          if (busy !== null) {
            throw new AppError(
              "AGENT_TASK_PERSONAL_TIME",
              `Это время занято: «${busy}». Выберите другое или спросите, когда удобно`,
            );
          }
        }
        const result = await client.query<{ id: string }>(
          `INSERT INTO shared_tasks(family_id,group_id,scope,creator_telegram_id,assignee_telegram_id,title,due_at,status,kind,list_name,details,due_on,
             space_id,recurrence_unit,recurrence_interval,recurrence_anchor_on,care_area_id)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::date,$17) RETURNING id`,
          [auth.familyId, scope === "group" ? auth.groupId : null, scope, auth.telegramUserId, assignee,
            input.title, input.dueAt ?? null,
            assignee === null ? "open" : assignee === auth.telegramUserId ? "accepted" : "proposed",
            input.kind ?? "task",input.listName ?? null,input.details ?? null,input.dueOn ?? null,
            // Область у дела это происхождение, а не право: доступ к нему остаётся по личности.
            // Но записать её надо сразу, иначе строка живёт без области до самого переключения.
            spaceId, input.repeat?.unit ?? null, input.repeat?.interval ?? null,
            // Якорь повтора это первая дата: от неё считаются все следующие, поэтому один
            // пропуск не сдвигает всё правило.
            input.repeat ? input.dueOn ?? null : null, careAreaId],
        );
        id = result.rows[0]!.id;
      } else {
        const {rows} = await readTasks(client, auth, scope, input.id!);
        if (!rows[0]) denied();
        const expectedVersion=await requireTaskRecordAction(client,auth,input.id!,taskSpaceAction(input));
        const locked = await client.query<TaskRow>(`SELECT *,due_on::text,recurrence_anchor_on::text AS recurrence_anchor_on
           FROM shared_tasks WHERE id=$1 FOR UPDATE`, [input.id]);
        const task = locked.rows[0];
        if (!task) denied();
        if(task.version!==expectedVersion) throw new AppError("AGENT_TASK_VERSION_CONFLICT","Задача изменилась. Прочитайте её заново");
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
          if (task.kind !== "task" && input.action !== "cancel") denied();
          const status = nextSharedTaskStatus(task.status, input.action,
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
            [task.id, status, input.action === "claim" ? auth.telegramUserId : null,
              ["cancelled", "completed", "declined"].includes(status)],
          );
          await recordTaskVersion(client, task, input.action, auth.telegramUserId!);
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
