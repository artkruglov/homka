/**
 * Groq voice credential validation boundary.
 *
 * Exports:
 * - `validateGroqVoiceCredential`: confirms authentication and active exact transcription access.
 *
 * Key constructs:
 * - Official Groq list envelope and model-object validation before availability checks.
 */
import { z } from "zod";

import { InstallerError } from "./errors.js";

const GROQ_MODELS_URL = "https://api.groq.com/openai/v1/models";
const TRANSCRIPTION_MODEL_ID = "whisper-large-v3-turbo";
const MAX_TIMEOUT_MS = 30_000;

const groqModelSchema = z.object({
  active: z.boolean(),
  context_window: z.number().int().positive(),
  created: z.number().int().nonnegative(),
  id: z.string().trim().min(1),
  object: z.literal("model"),
  owned_by: z.string().trim().min(1),
}).passthrough();
const groqModelsResponseSchema = z.object({
  data: z.array(groqModelSchema),
  object: z.literal("list"),
}).passthrough();

export async function validateGroqVoiceCredential(options: {
  readonly apiKey: string;
  readonly fetch: typeof globalThis.fetch;
  readonly timeoutMs: number;
}): Promise<void> {
  if (!options.apiKey || !Number.isInteger(options.timeoutMs)
    || options.timeoutMs < 1 || options.timeoutMs > MAX_TIMEOUT_MS) {
    throw new InstallerError(
      "OSINARA_INSTALL_GROQ_INPUT_INVALID",
      "Для проверки Groq передан некорректный ключ или таймаут",
    );
  }
  try {
    const response = await options.fetch(GROQ_MODELS_URL, {
      headers: { authorization: `Bearer ${options.apiKey}` },
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) throw new Error("Groq rejected the models request");
    const decoded: unknown = await response.json();
    const parsed = groqModelsResponseSchema.safeParse(decoded);
    if (!parsed.success) throw new Error("Groq returned an invalid models payload");

    // Listing means key-level access; the model is usable only while Groq explicitly marks it active.
    const transcriptionModel = parsed.data.data.find(({ id }) => id === TRANSCRIPTION_MODEL_ID);
    if (!transcriptionModel?.active) {
      throw new InstallerError(
        "OSINARA_INSTALL_GROQ_MODEL_UNAVAILABLE",
        `Groq API key не даёт доступ к обязательной модели ${TRANSCRIPTION_MODEL_ID}`,
      );
    }
  } catch (error) {
    if (error instanceof InstallerError) throw error;
    throw new InstallerError(
      "OSINARA_INSTALL_GROQ_VALIDATION_FAILED",
      "Не удалось проверить Groq API key. Проверьте сеть и доступ к моделям Groq",
      { cause: error },
    );
  }
}
