/**
 * Explicit hybrid memory search tool.
 *
 * Export:
 * - `search_memories` runs local embedding plus scoped PostgreSQL hybrid retrieval.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { memoryContextExposureRepository } from "../memory-context-exposure-repository.js";
import { requireMemoryAuthorization } from "../memory-context.js";
import { retrieveRelevantMemories } from "../memory-retrieval.js";

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})?)?$/u).refine(
  (value) => Number.isFinite(Date.parse(value)),
  "Дата должна быть корректной ISO-датой",
);

export default defineTool({
  description: [
    "Найти по словам и смыслу релевантные записи долговременной памяти в доступных областях для углубления контекста перед сложным ответом или действием.",
    "Если автоматической подборки недостаточно, вызови инструмент до трёх раз с разными смысловыми формулировками и остановись, когда контекста достаточно или новые релевантные факты больше не находятся.",
    "Для вопроса о периоде передай окно occurredAfter/occurredBefore: оно фильтрует по дате события, а без даты события по дате записи.",
  ].join(" "),
  inputSchema: z.object({
    query: z.string().min(1).max(2_000),
    occurredAfter: ISO_DATE.optional().describe("Начало окна по дате события (occurredAt, иначе дата записи), ISO 8601"),
    occurredBefore: ISO_DATE.optional().describe("Конец окна по дате события, ISO 8601"),
  }),
  async execute({ query, occurredAfter, occurredBefore }, ctx) {
    const auth = requireMemoryAuthorization(ctx);
    const applicationSessionId = ctx.session.auth.current?.attributes.applicationSessionId;
    const exposure = typeof applicationSessionId === "string"
      ? {
          applicationSessionId,
          sessionTurn: await memoryContextExposureRepository.sessionTurn(applicationSessionId),
        }
      : undefined;
    return await retrieveRelevantMemories(auth, query, exposure, {
      ...(occurredAfter === undefined ? {} : { occurredAfter }),
      ...(occurredBefore === undefined ? {} : { occurredBefore }),
    });
  },
});
