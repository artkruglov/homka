/**
 * Read-only personal and family agent schedule queries.
 *
 * Exports:
 * - `listAgentSchedules`: paginated schedules visible in trusted personal/family modes.
 * - `findAgentScheduleById`: one trusted personal/family schedule by opaque ID.
 */
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { decodeDateUuidCursor, encodeDateUuidCursor } from "../keyset-pagination.js";
import { AGENT_SCHEDULE_LIST_MAX_LIMIT } from "./agent-schedule-config.js";
import type { AgentScheduleAuthorization } from "./agent-schedule-context.js";
import {
  type AgentScheduleRecord,
  type AgentScheduleRow,
  rowToAgentSchedule,
} from "./agent-schedule-record.js";
import { memorySpaceParameters } from "../memory-context.js";
import {
  AGENT_SCHEDULE_COLUMNS,
  AGENT_SCHEDULE_SPACE_CLAUSE,
  agentScheduleVisibleInChat,
} from "./agent-schedule-repository-helpers.js";

export async function listAgentSchedules(
  auth: AgentScheduleAuthorization,
  options: { cursor?: string; limit: number },
): Promise<{ items: AgentScheduleRecord[]; nextCursor: string | null }> {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > AGENT_SCHEDULE_LIST_MAX_LIMIT) {
    throw new AppError("AGENT_SCHEDULE_LIMIT_INVALID", "Некорректный размер страницы расписаний");
  }
  const cursor = decodeDateUuidCursor(
    options.cursor,
    "AGENT_SCHEDULE_CURSOR_INVALID",
    "Не удалось продолжить просмотр агентных расписаний",
  );
  const result = await database().query<AgentScheduleRow>(
    `SELECT ${AGENT_SCHEDULE_COLUMNS}
       FROM agent_schedules AS schedule
      WHERE schedule.family_id = $1
        AND EXISTS (
          SELECT 1 FROM family_memberships
           WHERE family_id = $1 AND user_id = $3
        )
        AND (
          (schedule.scope = 'personal' AND schedule.owner_user_id = $3 AND $2::boolean) OR
          schedule.scope = 'family'
        )
        -- Сценарий написан для конкретной аудитории: две общие области одной семьи по виду
        -- записей неразличимы, и без области соседний prompt читался бы как свой.
        AND ${AGENT_SCHEDULE_SPACE_CLAUSE}
        AND ($7::timestamptz IS NULL OR (schedule.created_at, schedule.id) < ($7, $8::uuid))
      ORDER BY schedule.created_at DESC, schedule.id DESC
      LIMIT $9`,
    [auth.familyId, agentScheduleVisibleInChat(auth, { scope: "personal" }),
      auth.userId, ...memorySpaceParameters(auth), auth.groupId,
      cursor?.timestamp ?? null, cursor?.id ?? null, options.limit + 1],
  );
  const hasNext = result.rows.length > options.limit;
  const rows = result.rows.slice(0, options.limit);
  const last = rows.at(-1);
  return {
    items: rows.map(rowToAgentSchedule),
    nextCursor: hasNext && last ? encodeDateUuidCursor(last.created_at, last.id) : null,
  };
}

export async function findAgentScheduleById(
  auth: AgentScheduleAuthorization,
  id: string,
): Promise<AgentScheduleRecord | null> {
  const result = await database().query<AgentScheduleRow>(
    `SELECT ${AGENT_SCHEDULE_COLUMNS}
       FROM agent_schedules AS schedule
      WHERE schedule.id = $2 AND schedule.family_id = $1
        AND EXISTS (
          SELECT 1 FROM family_memberships
           WHERE family_id = $1 AND user_id = $3
        )
        AND (
          (schedule.scope = 'personal' AND schedule.owner_user_id = $3 AND $7::boolean) OR
          schedule.scope = 'family'
        )
        AND ${AGENT_SCHEDULE_SPACE_CLAUSE}`,
    [auth.familyId, id, auth.userId, ...memorySpaceParameters(auth), auth.groupId,
      agentScheduleVisibleInChat(auth, { scope: "personal" })],
  );
  return result.rows[0] ? rowToAgentSchedule(result.rows[0]) : null;
}
