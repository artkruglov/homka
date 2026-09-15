/**
 * Owner-only view of Mia's improvement backlog.
 *
 * Export:
 * - `review_improvements`: list open items, mark one done or dismiss it. Private owner chat only.
 *
 * Items are advisory observations Mia recorded about her own failed or heavy turns; nothing here
 * starts work or changes prompts.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { AppError } from "../app-error.js";
import { requirePrivateTelegramOwner } from "../family-context.js";
import { improvementBacklogRepository } from "../improvements/improvement-backlog-repository.js";

const inputSchema = z.object({
  action: z.enum(["dismiss", "done", "list"]).describe("list: открытые пункты; done: сделано; dismiss: не актуально"),
  id: z.string().uuid().optional().describe("done/dismiss: id пункта из list"),
  status: z.enum(["dismissed", "done", "open"]).optional().describe("list: какие пункты показать, по умолчанию open"),
}).strict();

export default defineTool({
  description: [
    "Бэклог собственных улучшений: наблюдения о собственных сбоях и тяжёлых ходах (упавшие инструменты, слишком длинные цепочки шагов). Только владелец, только личный чат.",
    "Когда применять: владелец спрашивает, что накопилось, что стоит починить, какие проблемы повторяются; или просит закрыть пункт. Сама не предлагай и не запускай ничего из бэклога.",
    'List: {"action":"list"}. Done: {"action":"done","id":"<uuid>"}. Dismiss: {"action":"dismiss","id":"<uuid>"}.',
  ].join(" "),
  inputSchema,
  async execute(input, ctx) {
    const owner = requirePrivateTelegramOwner(ctx);
    if (input.action === "list") {
      const items = await improvementBacklogRepository.list(owner.familyId, input.status ?? "open");
      return { items };
    }
    if (typeof input.id !== "string") {
      throw new AppError("AGENT_IMPROVEMENT_INPUT_INVALID", "Укажи id пункта из list");
    }
    const item = await improvementBacklogRepository.close({
      closedByUserId: owner.userId,
      familyId: owner.familyId,
      id: input.id,
      status: input.action === "done" ? "done" : "dismissed",
    });
    return { item };
  },
});
