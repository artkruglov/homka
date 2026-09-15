/**
 * Telegram delivery boundary for durable memory-thread creation notices.
 *
 * Exports:
 * - `MemoryThreadNoticeDeliveryRepository`: minimal injectable notice repository contract.
 * - `deliverPendingMemoryThreadNotice`: takes and sends one authorized informational notice.
 * - `productionMemoryThreadNotices`: production repository dependency for the Telegram handler.
 */
import { AppError } from "./app-error.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { memoryThreadNoticeRepository } from "./memory-thread-notice-repository.js";

export type MemoryThreadNoticeDeliveryRepository = Pick<
  typeof memoryThreadNoticeRepository,
  "complete" | "fail" | "takePending"
>;

export async function deliverPendingMemoryThreadNotice(
  auth: MemoryAuthorization,
  conversationId: string,
  notices: MemoryThreadNoticeDeliveryRepository,
  sendMessage: (text: string) => Promise<unknown>,
): Promise<void> {
  const notice = await notices.takePending(auth, conversationId);
  if (!notice) return;
  try {
    await sendMessage(`AGENT_MEMORY_THREAD_CREATED: ${notice.text}`);
    await notices.complete(notice.threadId, notice.deliveryToken, conversationId);
  } catch (error) {
    const definitive = error instanceof AppError && error.code.endsWith("_DELIVERY_FAILED");
    await notices.fail(
      notice.threadId,
      notice.deliveryToken,
      definitive
        ? "AGENT_MEMORY_THREAD_NOTICE_DELIVERY_FAILED"
        : "AGENT_MEMORY_THREAD_NOTICE_DELIVERY_AMBIGUOUS",
      !definitive,
    );
    throw error;
  }
}

export const productionMemoryThreadNotices = memoryThreadNoticeRepository;
