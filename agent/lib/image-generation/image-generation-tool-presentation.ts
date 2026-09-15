/**
 * External-group model presentation for subscription image generation.
 *
 * Export:
 * - `EXTERNAL_IMAGE_GENERATION_TOOL_PRESENTATION`: group-only description and input schema.
 */
import type { ToolDefinition } from "eve/tools";
import { z } from "zod";

type AnyToolDefinition = ToolDefinition<any, any>;

const IMAGE_PROMPT_MAX_LENGTH = 8_000;
const TELEGRAM_CAPTION_MAX_LENGTH = 1_024;

export const EXTERNAL_IMAGE_GENERATION_TOOL_PRESENTATION: Pick<
  AnyToolDefinition,
  "description" | "inputSchema"
> = {
  description: [
    "Создать одно raster-изображение (по настроенному провайдеру), сохранить его в group workspace и сразу отправить как photo в текущую внешнюю группу.",
    "В prompt опиши назначение, сцену, объект, композицию, стиль и запреты. Для unspecified size, quality или background передай auto.",
    "Для редактирования передай referencePaths исходных фотографий из group workspace. Требуется OpenRouter image provider. Не используй для SVG, code-native диаграмм или фоновой генерации.",
    "Если ошибка сообщает unknown status, не повторяй вызов автоматически: лимит подписки мог быть списан.",
  ].join(" "),
  inputSchema: z.object({
    referenceAttachmentIds: z.array(z.string().uuid()).min(1).max(4).optional()
      .describe("Фото из текущей группы: attachmentId из журнала, вместо referencePaths"),
    referencePaths: z.array(z.string().min(1).max(500)).min(1).max(4).optional(),
    background: z.enum(["transparent", "opaque", "auto"]),
    caption: z.string().min(1).max(TELEGRAM_CAPTION_MAX_LENGTH).optional(),
    prompt: z.string().min(1).max(IMAGE_PROMPT_MAX_LENGTH),
    quality: z.enum(["low", "medium", "high", "auto"]),
    size: z.enum(["1024x1024", "1536x1024", "1024x1536", "auto"]),
  }).strict(),
};
