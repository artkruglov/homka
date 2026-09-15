/**
 * Durable Telegram final-delivery crash-window tests.
 *
 * Constructs covered:
 * - A delivered replay returns stored receipts without another native send.
 * - A started/ambiguous replay never invokes Telegram again.
 * - A crash after provider acceptance but before chunk persistence becomes terminal ambiguity.
 * - Приостановленный по неподтверждённой аудитории ответ не уходит и после подтверждения: человек
 *   спрашивает заново, а не получает ответ на вопрос, который чат уже прошёл.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const repository = vi.hoisted(() => ({
  complete: vi.fn(),
  confirmChunk: vi.fn(),
  fail: vi.fn(),
  start: vi.fn(),
  suspend: vi.fn(),
}));

vi.mock("./telegram-final-delivery-repository.js", () => ({
  telegramFinalDeliveryRepository: repository,
}));

import {
  deliverTelegramFinalOutput,
  suspendTelegramFinalOutput,
} from "./telegram-final-delivery.js";

const base = {
  applicationSessionId: "00000000-0000-4000-8000-000000000001",
  deliveryIdentity: { chatId: "101" },
  eveSessionId: "wrun_session_1",
  eveTurnId: "turn-1",
  markdown: "Готово",
};

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

describe("Telegram final delivery", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks a suspended answer terminal under the same contract the retry computes", async () => {
    await suspendTelegramFinalOutput({
      ...base,
      diagnosticCode: "AGENT_SPACE_DELIVERY_AUDIENCE_UNPROVEN",
    });

    expect(repository.suspend).toHaveBeenCalledWith({
      applicationSessionId: base.applicationSessionId,
      chunkCount: 1,
      diagnosticCode: "AGENT_SPACE_DELIVERY_AUDIENCE_UNPROVEN",
      eveSessionId: base.eveSessionId,
      eveTurnId: base.eveTurnId,
      outputHash: hash({ chunks: [hash(base.markdown)], deliveryIdentity: base.deliveryIdentity }),
    });

    // Повтор того же хода видит терминальную строку и ничего не отправляет.
    repository.start.mockResolvedValue({
      diagnosticCode: "AGENT_SPACE_DELIVERY_AUDIENCE_UNPROVEN",
      status: "failed",
    });
    const sendChunk = vi.fn();
    await expect(deliverTelegramFinalOutput({ ...base, sendChunk }))
      .rejects.toThrowError(/AGENT_SPACE_DELIVERY_AUDIENCE_UNPROVEN/);
    expect(sendChunk).not.toHaveBeenCalled();
  });

  it("returns durable receipts on replay without a second send", async () => {
    repository.start.mockResolvedValue({
      messages: [{ chatType: "private", messageId: "501" }],
      status: "delivered",
    });
    const sendChunk = vi.fn();

    await expect(deliverTelegramFinalOutput({ ...base, sendChunk })).resolves.toEqual([
      { chatType: "private", messageId: "501" },
    ]);
    expect(repository.start).toHaveBeenCalledWith({
      applicationSessionId: base.applicationSessionId,
      chunkCount: 1,
      eveSessionId: base.eveSessionId,
      eveTurnId: base.eveTurnId,
      legacyChunkCount: 1,
      legacyOutputHash: hash({
        chunks: [hash(base.markdown)],
        deliveryIdentity: base.deliveryIdentity,
      }),
      outputHash: hash({
        chunks: [hash(base.markdown)],
        deliveryIdentity: base.deliveryIdentity,
      }),
    });
    expect(sendChunk).not.toHaveBeenCalled();
  });

  it("does not resend a delivery whose started state is crash-ambiguous", async () => {
    repository.start.mockResolvedValue({
      diagnosticCode: "AGENT_TELEGRAM_FINAL_DELIVERY_AMBIGUOUS",
      status: "ambiguous",
    });
    const sendChunk = vi.fn();

    await expect(deliverTelegramFinalOutput({ ...base, sendChunk }))
      .rejects.toThrowError(/AGENT_TELEGRAM_FINAL_DELIVERY_AMBIGUOUS/u);
    expect(sendChunk).not.toHaveBeenCalled();
  });

  it("marks acceptance-before-receipt-persistence as ambiguous without retrying", async () => {
    repository.start.mockResolvedValue({
      deliveryId: "00000000-0000-4000-8000-000000000002",
      deliveryToken: "00000000-0000-4000-8000-000000000003",
      status: "started",
    });
    repository.confirmChunk.mockRejectedValue(new Error("database disconnected after Telegram accepted"));
    const sendChunk = vi.fn().mockResolvedValue({ chatType: "private", messageId: "502" });

    await expect(deliverTelegramFinalOutput({ ...base, sendChunk }))
      .rejects.toThrowError("database disconnected after Telegram accepted");
    expect(sendChunk).toHaveBeenCalledTimes(1);
    expect(sendChunk).toHaveBeenCalledWith(
      { format: "plain", pacing: "immediate", text: "Готово" },
      0,
    );
    expect(repository.fail).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
      "AGENT_TELEGRAM_FINAL_DELIVERY_AMBIGUOUS",
      true,
    );
  });
});
