/** Creating one planner record inside the caller's transaction; the caller owns locks and replay. */
import type { PoolClient } from "pg";
import { AppError } from "./app-error.js";
import type { MemoryAuthorization, MemoryScope } from "./memory-context.js";
import type { SharedTaskInput } from "./shared-tasks.js";
import { denied, participants } from "./shared-task-access.js";
import { personalTimeRepository } from "./personal-time/personal-time-repository.js";
import { requireTaskRecipientSpace } from "./spaces/task-space-action.js";
import { isCurrentTelegramMember } from "./telegram-current-membership.js";
import { CARE_AREA_VISIBILITY, careAreaSpaceValues } from "./care-areas/care-area-access.js";

export async function createTask(
  client: PoolClient, auth: MemoryAuthorization, scope: MemoryScope, spaceId: string | null, input: SharedTaskInput,
): Promise<string> {
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
  // Личное время чужое: поставить на него дело нельзя. Название окна другому участнику не
  // показывается — по B02 о человеке можно сообщить только занятость, а не чем он занят.
  if (assignee !== null && assignee !== auth.telegramUserId && input.dueAt) {
    const busy = await personalTimeRepository.conflictFor(assignee, auth.familyId, new Date(input.dueAt));
    if (busy !== null) {
      throw new AppError(
        "AGENT_TASK_PERSONAL_TIME",
        "Это время занято личным временем человека. Выберите другое или спросите, когда удобно",
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
  return result.rows[0]!.id;
}
