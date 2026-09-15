/**
 * Публикация записи памяти в другую область.
 *
 * Экспорт:
 * - `publish_memory`: список областей и перенос выбранной записи с согласия человека.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { AppError } from "../app-error.js";
import { requireMemoryAuthorization } from "../memory-context.js";
import { MEMORY_REF_PATTERN } from "../model-memory.js";
import {
  listPublicationTargets,
  previewPublication,
  publishMemory,
} from "../relay/memory-publication.js";

export const publishMemoryInput = z.object({
  action: z.enum(["targets", "publish"]),
  areaRef: z.uuid().optional(),
  memoryRef: z.string().regex(MEMORY_REF_PATTERN).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.action === "targets" && (value.areaRef || value.memoryRef)) {
    ctx.addIssue({ code: "custom", message: "Для targets не передавай полей" });
  }
  if (value.action === "publish" && (!value.areaRef || !value.memoryRef)) {
    ctx.addIssue({ code: "custom", message: "Для publish нужны areaRef из targets и memoryRef" });
  }
});

export default defineTool({
  approval: ({ toolInput }) => {
    const parsed = publishMemoryInput.safeParse(toolInput);
    if (!parsed.success) {
      throw new AppError("AGENT_MEMORY_PUBLISH_INPUT_INVALID", "Проверьте область и запись");
    }
    // Расширение круга читателей подтверждает человек, видя точный текст и область.
    return parsed.data.action === "publish" ? "user-approval" : "not-applicable";
  },
  description: [
    "Перенести запись памяти в другую область этого человека: targets показывает области и их читателей, publish создаёт копию.",
    "publish: areaRef ровно из последнего targets и memoryRef записи. Копия самостоятельна: в целевой области появляется текст, но не исходная запись, её доказательства и история.",
    "Предлагай публикацию только по явной просьбе. Перенос расширяет круг читателей и необратим: отозвать прочитанное нельзя.",
    "Перед вызовом назови человеку точный текст и кто его увидит.",
  ].join(" "),
  inputSchema: publishMemoryInput,
  async execute(input, ctx) {
    const auth = requireMemoryAuthorization(ctx);
    if (input.action === "targets") return { targets: await listPublicationTargets(auth) };
    // Предпросмотр читается тем же путём, что и сама публикация: текст в окне подтверждения и
    // текст в целевой области обязаны совпадать.
    const preview = await previewPublication(auth, {
      areaRef: input.areaRef!, memoryRef: input.memoryRef!,
    });
    const published = await publishMemory(auth, {
      areaRef: input.areaRef!, memoryRef: input.memoryRef!,
    }, `${ctx.session.id}:${ctx.callId}`);
    return { ...published, kind: preview.kind };
  },
});
