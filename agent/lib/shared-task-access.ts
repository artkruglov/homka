/** Live authorization and scoped projections for the family planner. */
import type { PoolClient } from "pg";
import { spaceReadClause } from "./spaces/space-sql.js";
import { AppError } from "./app-error.js";
import type { MemoryAuthorization, MemoryScope } from "./memory-context.js";
import { CLOSED_TASK_STATUSES, UNFINISHED_TASK_STATUSES, type SharedTaskInput, type SharedTaskStatus } from "./shared-tasks.js";
import { isCurrentTelegramMember } from "./telegram-current-membership.js";
import { decodeDateUuidCursor, encodeDateUuidCursor, paginationFilterDigest } from "./keyset-pagination.js";
export interface TaskRow {
  id: string; family_id: string; space_id: string | null; group_id: string | null; scope: MemoryScope;
  creator_telegram_id: string; assignee_telegram_id: string | null; title: string;
  pending_assignee_telegram_id: string | null; pending_assignee: string | null;
  care_area_id: string | null;
  occurrence_index: number; recurrence_anchor_on: string | null;
  recurrence_interval: number | null;
  recurrence_unit: "daily" | "weekly" | "monthly" | "after_completion" | null;
  due_at: Date | null; due_on: string | null; kind: "task"|"idea"|"ritual"; list_name: string|null;
  details: string|null; version: number; planned_from: string|null; planned_until: string|null;
  original_text?: { title: string; details: string | null };
  reminder_created:boolean; created_at: Date; telegram_chat_id: string|null; status: SharedTaskStatus; source: string; assignee: string|null;
}

/** Текущая календарная дата в поясе человека, без переноса часов через полночь UTC. */
export function localDate(timezone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(now);
}

export function denied(): never {
  throw new AppError("AGENT_TASK_ACCESS_DENIED", "Задача или участник недоступны в текущем чате");
}

export async function authorize(client: PoolClient, auth: MemoryAuthorization): Promise<MemoryScope> {
  if (auth.telegramActorKind !== "telegram_user" || !auth.telegramUserId ||
    auth.telegramActorId !== auth.telegramUserId) denied();
  if (auth.groupId) {
    const group = await client.query<{ type: string; tool_allowlist: string[] }>(
      "SELECT type, tool_allowlist FROM telegram_groups WHERE id=$1 AND family_id=$2 FOR SHARE",
      [auth.groupId, auth.familyId],
    );
    const row = group.rows[0];
    if (!row) denied();
    if (row.type === "external") {
      if (auth.scopes.length !== 1 || auth.scopes[0] !== "group" || !row.tool_allowlist.includes("manage_shared_tasks")) denied();
      return "group";
    }
    if (row.type !== "family_private" || auth.scopes.length !== 1 || auth.scopes[0] !== "family") denied();
  } else if (!auth.scopes.includes("personal") || auth.role === "external") denied();
  const member = await client.query(
    `SELECT 1 FROM family_memberships m JOIN users u ON u.id=m.user_id
     WHERE m.family_id=$1 AND m.user_id=$2 AND u.telegram_user_id=$3 FOR SHARE OF m,u`,
    [auth.familyId, auth.userId, auth.telegramUserId],
  );
  if (!member.rowCount) denied();
  return auth.groupId ? "family" : "personal";
}

function visible(scope: MemoryScope, view?: string): string {
  // Незанятое дело, заведённое мной, это тоже ожидание: его ещё никто не взял.
  const waiting = "t.creator_telegram_id=$2 AND t.assignee_telegram_id IS DISTINCT FROM $2";
  // «Что я обещал» это дело, которое поручил мне другой человек, а не моя собственная запись.
  const promised = "t.assignee_telegram_id=$2 AND t.creator_telegram_id<>$2";
  // The private inbox contains assignments and the caller's chosen ideas and rituals.
  if (scope === "personal") {
    if (view === "waiting") return waiting;
    if (view === "promised") return promised;
    if (view === "transfers") return "t.pending_assignee_telegram_id=$2";
    // Семейная традиция общая: её видят оба, иначе второй человек не знал бы о том, что семья
    // решила поддерживать. Чужая личная идея остаётся личной.
    return "(t.assignee_telegram_id=$2 OR (t.kind<>'task' AND (pplan.telegram_user_id=$2 OR t.scope='family')))";
  }
  const area = scope === "family" ? "t.scope='family'" : "t.scope='group' AND t.group_id=$3";
  if (view === "waiting") return `${area} AND ${waiting}`;
  if (view === "mine") return `${area} AND t.assignee_telegram_id=$2`;
  if (view === "promised") return `${area} AND ${promised}`;
  // Запрос передачи ждёт именно получателя: в его списке он и должен появиться.
  if (view === "transfers") return `${area} AND t.pending_assignee_telegram_id=$2`;
  if (view === "open") return `${area} AND t.status='open'`;
  return area;
}

/**
 * Имена списков — это не страница дел. Прежде они собирались из выданной страницы, поэтому при
 * непустом курсоре часть списков исчезала. Источник возвращается рядом с именем: одинаковое имя в
 * разных чатах это разные списки, и смешивать их нельзя.
 */
export async function listNames(
  client: PoolClient, auth: MemoryAuthorization, scope: MemoryScope,
): Promise<{ listName: string; source: string; itemCount: number; unfinishedItemCount: number }[]> {
  const result = await client.query<{ group_id: string | null; list_name: string; source: string; item_count: number; unfinished_item_count: number }>(
    `SELECT t.list_name, t.group_id, count(*)::integer AS item_count,
        count(*) FILTER (WHERE t.status IN ('open','proposed','accepted'))::integer AS unfinished_item_count,
        COALESCE(task_space.title, g.title, CASE WHEN t.scope='family' THEN 'Семья' ELSE 'Личное' END) AS source
       FROM shared_tasks t LEFT JOIN telegram_groups g ON g.id=t.group_id
     LEFT JOIN spaces task_space ON task_space.id=t.space_id AND task_space.family_id=t.family_id
       LEFT JOIN shared_task_plans pplan ON pplan.task_id=t.id AND pplan.telegram_user_id=$2
      WHERE t.family_id=$1 AND t.list_name IS NOT NULL AND (${visible(scope)})
        AND ($3::uuid IS NULL OR TRUE)
      AND ${spaceReadClause({alias:"t",parameters:{family:"$1",group:"$3",spaceId:"$4",version:"$5",user:"$6"}})}
      GROUP BY t.list_name,t.group_id,t.scope,g.title,t.space_id,task_space.title
      ORDER BY source, t.list_name LIMIT 200`,
    [auth.familyId, auth.telegramUserId, auth.groupId, auth.space?.spaceId ?? null, auth.space?.policyVersion ?? null, auth.userId],
  );
  // Имя списка и название чата раскрывают не меньше, чем само дело, поэтому отзыв доступа
  // действует здесь так же: без этой проверки вышедший из группы продолжал бы их видеть.
  const { rows } = await keepLiveGroupRows(client, auth, result.rows);
  return rows.map((row) => ({ listName: row.list_name, source: row.source,
    itemCount: row.item_count, unfinishedItemCount: row.unfinished_item_count }));
}

/**
 * «Сегодня» — это срок или личный план на текущий день плюс всё, что этот день уже пропустило.
 * День берётся в часовом поясе человека: полночь по UTC для Москвы наступает в три часа ночи, и
 * вечернее дело иначе выпало бы из своего же дня.
 */
const TODAY = `t.kind='task' AND t.status IN ('open','proposed','accepted') AND (
  t.due_on IS NOT NULL AND t.due_on <= ($13::date)
  OR t.due_at IS NOT NULL AND t.due_at < (($13::date + 1) AT TIME ZONE $14)
  OR pplan.planned_from <= $13::date AND pplan.planned_until >= $13::date
)`;

/** Просроченное идёт первым: это то, что уже подвело, а не то, что предстоит. */
const TODAY_ORDER = `CASE
    WHEN t.due_on IS NOT NULL AND t.due_on < $13::date THEN 0
    WHEN t.due_at IS NOT NULL AND t.due_at < ($13::date AT TIME ZONE $14) THEN 0
    WHEN t.due_on IS NOT NULL OR t.due_at IS NOT NULL THEN 1 ELSE 2 END,
  COALESCE(t.due_at, (t.due_on AT TIME ZONE $14)), date_trunc('milliseconds',t.created_at), t.id`;

/**
 * Список показывает незакрытое, пока не попросили иначе: закрытые и отменённые в общем выводе
 * заставляли модель перебирать реестр, чтобы понять, что осталось. Чтение по id видит запись в
 * любом статусе — иначе повтор операции и ответ после закрытия не нашли бы только что закрытое.
 */
function listedStatuses(id: string | readonly string[] | null, input: SharedTaskInput): readonly string[] | null {
  if (id !== null) return null;
  if (input.status) return [input.status];
  return input.view === "done" ? CLOSED_TASK_STATUSES : UNFINISHED_TASK_STATUSES;
}

export async function readTasks(client: PoolClient, auth: MemoryAuthorization, scope: MemoryScope,
  id: string | readonly string[] | null = null, input: SharedTaskInput = {action:"list"}, timezone = "UTC") {
  // Even filtering shared records by a private plan would reveal that plan in the group.
  if (auth.groupId && (input.view === "planned" || input.from || input.until)) denied();
  const binding=paginationFilterDigest([auth.familyId,auth.telegramUserId,auth.groupId,auth.space?.spaceId ?? null,auth.space ? String(auth.space.policyVersion) : null,scope,input.view ?? null,input.status ?? null,input.listName ?? null,input.from ?? null,input.until ?? null,input.careAreaRef ?? null]);
  const cursor = input.cursor ? decodeDateUuidCursor(input.cursor,"AGENT_TASK_CURSOR_INVALID","Не удалось продолжить список",binding) : null;
  const result = await client.query<TaskRow>(
    `SELECT t.*, t.recurrence_anchor_on::text AS recurrence_anchor_on,
      COALESCE((SELECT jsonb_build_object('title',v.previous_record->'title','details',v.previous_record->'details')
        FROM shared_task_versions v WHERE v.task_id=t.id ORDER BY v.version LIMIT 1),
        jsonb_build_object('title',t.title,'details',t.details)) AS original_text,
      date_trunc('milliseconds',t.created_at) AS created_at, EXISTS(SELECT 1 FROM reminders r JOIN users ru ON ru.id=r.author_user_id
       WHERE r.shared_task_id=t.id AND ru.telegram_user_id=$2 AND r.status IN ('active','leased')) AS reminder_created, t.due_on::text, pplan.planned_from::text, pplan.planned_until::text, g.telegram_chat_id,
      COALESCE(task_space.title, g.title, CASE WHEN t.scope='family' THEN 'Семья' ELSE 'Личное' END) AS source,
      CASE WHEN t.assignee_telegram_id IS NULL THEN NULL
        ELSE COALESCE(u.display_name, p.display_name, 'Участник') END AS assignee,
      (SELECT COALESCE(pu.display_name, pp.display_name, 'Участник')
         FROM (SELECT 1) AS one
         LEFT JOIN users pu ON pu.telegram_user_id = t.pending_assignee_telegram_id
         LEFT JOIN shared_task_participants pp ON pp.family_id = t.family_id
           AND pp.group_id IS NOT DISTINCT FROM t.group_id
           AND pp.telegram_user_id = t.pending_assignee_telegram_id
        WHERE t.pending_assignee_telegram_id IS NOT NULL) AS pending_assignee
     FROM shared_tasks t LEFT JOIN telegram_groups g ON g.id=t.group_id
     LEFT JOIN spaces task_space ON task_space.id=t.space_id AND task_space.family_id=t.family_id
     LEFT JOIN shared_task_plans pplan ON pplan.task_id=t.id AND pplan.telegram_user_id=$2
     LEFT JOIN users u ON u.telegram_user_id=t.assignee_telegram_id
     LEFT JOIN shared_task_participants p ON p.family_id=t.family_id
       AND p.group_id IS NOT DISTINCT FROM t.group_id AND p.telegram_user_id=t.assignee_telegram_id
     WHERE t.family_id=$1 AND (${visible(scope, input.view)}) AND ($4::uuid[] IS NULL OR t.id=ANY($4::uuid[]))
       AND ($5::text[] IS NULL OR t.status=ANY($5::text[]))
       AND ($3::uuid IS NULL OR TRUE) AND ($2::text IS NOT NULL)
       AND ($6::text IS NULL OR t.list_name=$6)
       AND ($7::text IS NULL OR t.kind=$7)
       AND ($12::boolean=false OR pplan.task_id IS NOT NULL)
       AND ($8::date IS NULL OR (pplan.planned_from <= $9 AND pplan.planned_until >= $8))
       AND ($10::timestamptz IS NULL OR (date_trunc('milliseconds',t.created_at),t.id)<($10,$11::uuid))
       AND ($13::date IS NULL OR (${TODAY}))
       AND ($15::uuid IS NULL OR t.care_area_id=$15)
       AND ${spaceReadClause({alias:"t",parameters:{family:"$1",group:"$3",spaceId:"$17",version:"$18",user:"$19"}})}
       AND ($16::boolean=false OR (t.kind IN ('idea','task') AND t.status IN ('open','accepted')
         AND t.due_at IS NULL AND t.due_on IS NULL AND ($3::uuid IS NOT NULL OR pplan.task_id IS NULL)
         AND NOT EXISTS(SELECT 1 FROM shared_task_versions v WHERE v.task_id=t.id AND v.action IN ('clarify','activate'))))
     ORDER BY ${input.view === "today" ? TODAY_ORDER : "date_trunc('milliseconds',t.created_at) DESC, t.id DESC"}
     LIMIT 101`,
    [auth.familyId, auth.telegramUserId, auth.groupId, id === null ? null : typeof id === "string" ? [id] : [...id],
      listedStatuses(id, input), input.listName ?? null,
      input.view === "ideas" ? "idea" : input.view === "rituals" ? "ritual" : ["mine","waiting","open","promised","transfers"].includes(input.view ?? "") ? "task" : null,
      input.from ?? null,input.until ?? null,cursor?.timestamp ?? null,cursor?.id ?? null,input.view === "planned",
      input.view === "today" ? localDate(timezone) : null, timezone, input.careAreaRef ?? null, input.view === "inbox", auth.space?.spaceId ?? null, auth.space?.policyVersion ?? null, auth.userId],
  );
  const page = result.rows.slice(0,100);
  const { rows, incomplete } = await keepLiveGroupRows(client, auth, page);
  return {rows, incomplete, nextCursor:result.rows.length>100 ? encodeDateUuidCursor(result.rows[99]!.created_at,result.rows[99]!.id,binding):null};
}

/**
 * Отсеивает строки групп, в которых человека уже нет. Отзыв доступа действует сразу, поэтому
 * проверка живая, а не по снимку сессии; она общая для дел и для имён списков, иначе название
 * закрытого чата утекало бы тем путём, который её не делает.
 */
export async function keepLiveGroupRows<Row extends { group_id: string | null }>(
  client: PoolClient, auth: MemoryAuthorization, page: readonly Row[],
): Promise<{ rows: Row[]; incomplete: boolean }> {
  // Права на группу проверяются по одному разу на группу и не больше чем для десяти групп страницы.
  const groupIds = [...new Set(page.flatMap((row) => row.group_id ? [row.group_id] : []))];
  const checked = groupIds.slice(0,10);
  const registrations = new Map<string,string|null>();
  for (const groupId of checked) {
    const registration = await client.query<{ telegram_chat_id: string }>(
      `SELECT telegram_chat_id FROM telegram_groups
        WHERE id=$1 AND family_id=$2 AND type='external' AND 'manage_shared_tasks'=ANY(tool_allowlist) FOR SHARE`,
      [groupId,auth.familyId]);
    registrations.set(groupId, registration.rows[0]?.telegram_chat_id ?? null);
  }
  // Живая проверка членства идёт в Telegram, а транзакция уже держит блокировки строк. Десять
  // проверок подряд удерживали бы их до полутора минут, поэтому окно ожидания здесь одно на все.
  const grants = new Map<string,boolean>(await Promise.all(checked.map(async (groupId): Promise<[string,boolean]> => {
    const chatId = registrations.get(groupId) ?? null;
    return [groupId, chatId !== null && await isCurrentTelegramMember(chatId,auth.telegramUserId!)];
  })));
  const rows: Row[]=[];
  let incomplete = groupIds.length > checked.length;
  for (const row of page) {
    if (row.group_id && !grants.get(row.group_id)) { incomplete=true; continue; }
    rows.push(row);
  }
  return { rows, incomplete };
}

export function present(row: TaskRow, personalPlan=true) {
  return { id: row.id, title: row.title, status: row.status, dueAt: row.due_at?.toISOString() ?? null,
    source: row.source, assignee: row.kind === "task" ? row.assignee : null, curator:row.kind !== "task" ? row.assignee : null, scope: row.scope, reminderCreated: personalPlan ? row.reminder_created : null,
    kind:row.kind, listName:row.list_name, details:row.details, dueOn:row.due_on,version:row.version,
    originalText:row.original_text ?? {title:row.title,details:row.details},
    pendingAssignee:row.pending_assignee,
    careAreaRef:row.care_area_id ?? null,
    repeat: row.recurrence_unit === null ? null
      : { interval: row.recurrence_interval, unit: row.recurrence_unit },
    plannedFrom:personalPlan ? row.planned_from : null,plannedUntil:personalPlan ? row.planned_until : null,
    commitment:row.kind === "task", };
}

/**
 * Строка списка: чтобы выбрать дело и действовать по id, хватает названия, статуса, срока и
 * источника. Описание, исходная формулировка и область заботы приходят только по `get`:
 * двадцать полей на строку делали каждый list тяжёлым и подталкивали перечитывать реестр.
 */
export function presentSummary(row: TaskRow, personalPlan=true) {
  const full = present(row, personalPlan);
  return { id: full.id, title: full.title, status: full.status, kind: full.kind, dueAt: full.dueAt,
    dueOn: full.dueOn, source: full.source, assignee: full.assignee, curator: full.curator,
    listName: full.listName, version: full.version, repeat: full.repeat,
    pendingAssignee: full.pendingAssignee, reminderCreated: full.reminderCreated,
    plannedFrom: full.plannedFrom, plannedUntil: full.plannedUntil };
}

export async function participants(client: PoolClient, auth: MemoryAuthorization, scope: MemoryScope) {
  if (scope === "group") {
    // Only real humans observed through the verified journal of this exact group are candidates.
    await client.query(
      `INSERT INTO shared_task_participants(family_id,group_id,telegram_user_id,display_name)
       SELECT $1,$2,telegram_user_id,COALESCE(sender_display_name,'Участник') FROM (
         SELECT DISTINCT ON (telegram_user_id) telegram_user_id,sender_display_name
         FROM telegram_group_messages WHERE group_id=$2 AND actor_kind='user'
           AND telegram_user_id IS NOT NULL AND NOT sender_is_bot
         ORDER BY telegram_user_id,sequence_id DESC
       ) people ON CONFLICT (family_id,group_id,telegram_user_id)
       DO UPDATE SET display_name=excluded.display_name`, [auth.familyId, auth.groupId],
    );
  } else if (scope === "family") {
    await client.query(
      `INSERT INTO shared_task_participants(family_id,group_id,telegram_user_id,display_name)
       SELECT m.family_id,NULL,u.telegram_user_id,u.display_name FROM family_memberships m
       JOIN users u ON u.id=m.user_id WHERE m.family_id=$1
       ON CONFLICT (family_id,group_id,telegram_user_id) DO UPDATE SET display_name=excluded.display_name`,
      [auth.familyId],
    );
  }
  if (scope === "personal") return [];
  const rows = await client.query<{ id: string; display_name: string }>(
    `SELECT p.id,p.display_name FROM shared_task_participants p
     WHERE p.family_id=$1 AND p.group_id IS NOT DISTINCT FROM $2::uuid
       AND ($2::uuid IS NOT NULL OR EXISTS (SELECT 1 FROM users u JOIN family_memberships m ON m.user_id=u.id
         WHERE m.family_id=$1 AND u.telegram_user_id=p.telegram_user_id))
       AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM space_memberships sm JOIN users su ON su.id=sm.user_id
         WHERE sm.family_id=$1 AND sm.space_id=$3 AND sm.state='active' AND su.telegram_user_id=p.telegram_user_id))
     ORDER BY p.display_name,p.id LIMIT 100`, [auth.familyId, scope === "group" ? auth.groupId : null,
       scope === "family" ? auth.space?.spaceId ?? null : null],
  );
  return rows.rows.map(row => ({ participantRef: row.id, name: row.display_name }));
}
