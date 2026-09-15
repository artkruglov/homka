/**
 * Crash-safe orchestration for one native Telegram final message.
 *
 * Exports:
 * - `deliverTelegramFinalOutput`: sends plain or rich chunks once behind the durable outbox barrier.
 * - `suspendTelegramFinalOutput`: closes the same barrier terminally without sending anything.
 */
import { createHash } from "node:crypto";

import { AppError } from "./app-error.js";
import {
  formatTelegramFinalPresentation,
  type TelegramFinalPresentationChunk,
} from "./telegram-final-presentation.js";
import type { SentTelegramMessage } from "./telegram-rich-messages.js";
import { telegramFinalDeliveryRepository } from "./telegram-final-delivery-repository.js";
import { formatTelegramRichMessages } from "./telegram-rich-markdown.js";

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function terminalDeliveryError(code: string): AppError {
  return new AppError(
    code,
    "Доставка ответа Telegram уже начиналась и не будет повторена автоматически",
  );
}

interface DeliveryIdentityInput {
  applicationSessionId: string;
  deliveryIdentity: unknown;
  eveSessionId: string;
  eveTurnId: string;
  markdown: string;
}

/** Один и тот же отпечаток у отправки и у приостановки: иначе повтор не узнает свою строку. */
function deliveryContract(input: DeliveryIdentityInput) {
  const chunks = formatTelegramFinalPresentation(input.markdown);
  const legacyChunks = formatTelegramRichMessages(input.markdown);
  return {
    chunks,
    legacyChunkCount: legacyChunks.length,
    legacyOutputHash: hash({
      chunks: legacyChunks.map((chunk) => hash(chunk)),
      deliveryIdentity: input.deliveryIdentity,
    }),
    outputHash: hash({
      chunks: chunks.map((chunk) => hash(chunk.text)),
      deliveryIdentity: input.deliveryIdentity,
    }),
  };
}

/**
 * Аудитория чата не подтверждена, поэтому ответ не уходит — и не уйдёт потом. Барьер закрывается
 * терминально, чтобы повтор того же хода не отправил в чат ответ на вопрос, который чат уже
 * прошёл: человек спрашивает заново, а владелец узнаёт о приостановке.
 */
export async function suspendTelegramFinalOutput(
  input: DeliveryIdentityInput & { diagnosticCode: string },
): Promise<void> {
  const contract = deliveryContract(input);
  await telegramFinalDeliveryRepository.suspend({
    applicationSessionId: input.applicationSessionId,
    chunkCount: contract.chunks.length,
    diagnosticCode: input.diagnosticCode,
    eveSessionId: input.eveSessionId,
    eveTurnId: input.eveTurnId,
    outputHash: contract.outputHash,
  });
}

export async function deliverTelegramFinalOutput(input: DeliveryIdentityInput & {
  sendChunk(chunk: TelegramFinalPresentationChunk, ordinal: number): Promise<SentTelegramMessage>;
}): Promise<SentTelegramMessage[]> {
  const { chunks, legacyChunkCount, legacyOutputHash, outputHash } = deliveryContract(input);
  const start = await telegramFinalDeliveryRepository.start({
    applicationSessionId: input.applicationSessionId,
    chunkCount: chunks.length,
    eveSessionId: input.eveSessionId,
    eveTurnId: input.eveTurnId,
    legacyChunkCount,
    legacyOutputHash,
    outputHash,
  });
  if (start.status === "delivered") return start.messages;
  if (start.status !== "started") throw terminalDeliveryError(start.diagnosticCode);

  const sent: SentTelegramMessage[] = [];
  try {
    for (const [ordinal, chunk] of chunks.entries()) {
      const message = await input.sendChunk(chunk, ordinal);
      await telegramFinalDeliveryRepository.confirmChunk({
        chatType: message.chatType,
        contentHash: hash(chunk.text),
        deliveryId: start.deliveryId,
        deliveryToken: start.deliveryToken,
        messageId: message.messageId,
        ordinal,
      });
      sent.push(message);
    }
    await telegramFinalDeliveryRepository.complete(start.deliveryId, start.deliveryToken);
    return sent;
  } catch (error) {
    const definitive = error instanceof AppError && error.code.endsWith("_DELIVERY_FAILED");
    await telegramFinalDeliveryRepository.fail(
      start.deliveryId,
      start.deliveryToken,
      definitive
        ? "AGENT_TELEGRAM_FINAL_DELIVERY_FAILED"
        : "AGENT_TELEGRAM_FINAL_DELIVERY_AMBIGUOUS",
      !definitive,
    );
    throw error;
  }
}
