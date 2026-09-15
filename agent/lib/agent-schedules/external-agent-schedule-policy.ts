/**
 * External-group scheduled automation capability policy.
 *
 * Exports:
 * - `EXTERNAL_SCHEDULE_CAPABILITIES`: safe capabilities an owner may persist for an automation.
 * - `ExternalScheduleCapability`: validated persisted scheduled capability name.
 * - `parseExternalScheduleCapabilities`: complete-list validation without partial grants.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { parseExternalGroupToolAllowlist } from "../tool-policy/group-tool-catalog.js";
import type { ExternalGroupToolName } from "../tool-policy/group-tool-catalog.js";
import type { MutableAgentScheduleRow } from "./agent-schedule-repository-helpers.js";

const HISTORY_WINDOW_MAX_DAYS = 365;

export const EXTERNAL_SCHEDULE_CAPABILITIES = [
  "inspect_workspace_image",
  "list_memories",
  "list_memory_threads",
  "read_memory_thread",
  "search_memories",
  "search_memory_threads",
  "send_workspace_file",
  "web_fetch",
] as const satisfies readonly ExternalGroupToolName[];

export type ExternalScheduleCapability = (typeof EXTERNAL_SCHEDULE_CAPABILITIES)[number];

export function parseExternalScheduleCapabilities(
  value: unknown,
): ReadonlySet<ExternalScheduleCapability> | null {
  if (!Array.isArray(value)) return null;
  const allowed = new Set<ExternalScheduleCapability>();
  for (const capability of value) {
    if (
      typeof capability !== "string" ||
      !(EXTERNAL_SCHEDULE_CAPABILITIES as readonly string[]).includes(capability) ||
      allowed.has(capability as ExternalScheduleCapability)
    ) {
      return null;
    }
    allowed.add(capability as ExternalScheduleCapability);
  }
  return allowed;
}

export function requireExternalScheduleHistoryWindowDays(
  value: number | null | undefined,
): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (!Number.isInteger(value) || value < 1 || value > HISTORY_WINDOW_MAX_DAYS) {
    throw new AppError(
      "AGENT_EXTERNAL_SCHEDULE_HISTORY_WINDOW_INVALID",
      `historyWindowDays должен быть целым числом от 1 до ${HISTORY_WINDOW_MAX_DAYS}`,
    );
  }
  return value;
}

export async function requireUpdatedExternalScheduleCapabilities(
  client: PoolClient,
  schedule: MutableAgentScheduleRow,
  value: ExternalScheduleCapability[] | undefined,
): Promise<ExternalScheduleCapability[] | undefined> {
  if (value === undefined) return undefined;
  const scheduled = parseExternalScheduleCapabilities(value);
  if (!scheduled || schedule.scope !== "group" || schedule.group_id === null) {
    throw new AppError(
      "AGENT_EXTERNAL_SCHEDULE_CAPABILITIES_INVALID",
      "Возможности внешней автоматизации указаны некорректно",
    );
  }
  const group = await client.query<{ tool_allowlist: string[] }>(
    `SELECT tool_allowlist FROM telegram_groups
      WHERE id = $1 AND family_id = $2 AND type = 'external'
      FOR SHARE`,
    [schedule.group_id, schedule.family_id],
  );
  const current = parseExternalGroupToolAllowlist(group.rows[0]?.tool_allowlist);
  if (!current) {
    throw new AppError(
      "AGENT_EXTERNAL_SCHEDULE_GROUP_NOT_FOUND",
      "Целевая внешняя группа больше не зарегистрирована",
    );
  }
  for (const capability of scheduled) {
    if (!current.has(capability)) {
      throw new AppError(
        "AGENT_EXTERNAL_SCHEDULE_CAPABILITY_NOT_GRANTED",
        `В целевой группе сейчас не разрешена capability ${capability}`,
      );
    }
  }
  return [...scheduled];
}
