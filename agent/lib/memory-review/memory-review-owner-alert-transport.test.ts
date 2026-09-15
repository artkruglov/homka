/**
 * Telegram transport tests for owner-private memory-review failure alerts.
 *
 * Constructs covered:
 * - `createMemoryReviewOwnerAlertTransport`: bounded direct send with no implicit retry.
 * - HTTP rejection is definite while transport uncertainty is classified by the dispatcher.
 */
import { describe, expect, it, vi } from "vitest";

import {
  createMemoryReviewOwnerAlertTransport,
  MemoryReviewOwnerAlertTransportError,
} from "./memory-review-owner-alert-transport.js";

describe("memory review owner alert transport", () => {
  it("sends plain text to the exact private owner chat", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ ok: true, result: { message_id: 42 } }),
      { status: 200 },
    ));
    const transport = createMemoryReviewOwnerAlertTransport({
      botToken: "telegram-bot-secret",
      fetch: fetchMock,
      timeoutMilliseconds: 15_000,
    });

    await expect(transport.deliver({ chatId: "101", text: "Проверка памяти остановлена" }))
      .resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottelegram-bot-secret/sendMessage",
      expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }),
    );
    const request = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      chat_id: "101",
      text: "Проверка памяти остановлена",
    });
  });

  it("classifies an HTTP rejection as a definite delivery failure", async () => {
    const transport = createMemoryReviewOwnerAlertTransport({
      botToken: "telegram-bot-secret",
      fetch: vi.fn().mockResolvedValue(new Response("{}", { status: 403 })),
      timeoutMilliseconds: 15_000,
    });

    await expect(transport.deliver({ chatId: "101", text: "Проверка памяти остановлена" }))
      .rejects.toMatchObject({
        code: "AGENT_MEMORY_REVIEW_OWNER_ALERT_TELEGRAM_REJECTED",
        delivery: "failed",
      } satisfies Partial<MemoryReviewOwnerAlertTransportError>);
  });
});
