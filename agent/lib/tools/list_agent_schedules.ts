/**
 * Eve list tool for scheduled agent scenarios.
 *
 * Export:
 * - `list_agent_schedules` returns current-user personal and family schedules.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  AGENT_SCHEDULE_LIST_DEFAULT_LIMIT,
  AGENT_SCHEDULE_LIST_MAX_LIMIT,
} from "../agent-schedules/agent-schedule-config.js";
import { requireAgentScheduleAuthorization } from "../agent-schedules/agent-schedule-context.js";
import { agentScheduleRepository } from "../agent-schedules/agent-schedule-repository.js";

export default defineTool({
  description: [
    "Постранично показать личные и семейные агентные расписания текущего пользователя.",
    "Результат: {items,nextCursor}; если nextCursor не null, передай его без изменений для следующей страницы.",
  ].join(" "),
  inputSchema: z.object({
    cursor: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(AGENT_SCHEDULE_LIST_MAX_LIMIT)
      .default(AGENT_SCHEDULE_LIST_DEFAULT_LIMIT),
  }).strict(),
  async execute(input, ctx) {
    return await agentScheduleRepository.list(requireAgentScheduleAuthorization(ctx), input);
  },
});
