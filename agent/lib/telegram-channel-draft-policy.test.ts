/**
 * Telegram channel draft-rate regression contract.
 *
 * Constructs covered:
 * - The channel does not emit text-like drafts before knowing the terminal delivery kind.
 * - Token deltas and tool-loop events never trigger draft API calls.
 * - Scheduled Telegram delivery is reauthorized before send and confirmed before timeline persistence.
 * - Turn start never launches a second semantic pass over the conversation.
 * - Turn-bound memory sources survive HITL and release only at a terminal turn boundary.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const TELEGRAM_CHANNEL_PATH = new URL("../channels/telegram.ts", import.meta.url);

describe("Telegram channel draft policy", () => {
  it("keeps reaction-capable turns free of speculative Telegram drafts", async () => {
    const source = await readFile(TELEGRAM_CHANNEL_PATH, "utf8");

    expect(source).toContain('async "turn.started"');
    expect(source).not.toContain("startTelegramRichThinkingDraft");
    expect(source).not.toContain('"message.appended"');
    expect(source).not.toContain('"action.result"');
    // `actions.requested` may only release or keep a held progress notice, never draft text.
    const actionsHandler = source.slice(source.indexOf('async "actions.requested"'));
    const handlerBody = actionsHandler.slice(0, actionsHandler.indexOf('async "turn.failed"'));
    expect(handlerBody).toContain("telegramProgressNoticeDeferral.release(");
    expect(handlerBody).not.toContain("postTelegram");
    expect(handlerBody).not.toContain("Draft");
  });

  it("records scheduled delivery confirmation before the group timeline", async () => {
    const source = await readFile(TELEGRAM_CHANNEL_PATH, "utf8");
    const authorization = source.indexOf("await agentScheduleDispatchRepository.authorizeDelivery(");
    const delivery = source.indexOf("await deliverTelegramFinalOutput(");
    const confirmation = source.indexOf("await agentScheduleDispatchRepository.completeDeliveredRun(");
    const timeline = source.indexOf("await telegramGroupJournalRepository.recordAgentResponse(");

    expect(authorization).toBeGreaterThan(-1);
    expect(delivery).toBeGreaterThan(authorization);
    expect(confirmation).toBeGreaterThan(-1);
    expect(timeline).toBeGreaterThan(confirmation);
    expect(source).not.toContain("agentScheduleDispatchRepository.completeRun(");
    expect(source).toContain("AGENT_SCHEDULE_DELIVERY_CONFIRMATION_MISSING");
  });

  it("does not create background extraction work at turn start", async () => {
    const source = await readFile(TELEGRAM_CHANNEL_PATH, "utf8");

    expect(source).not.toContain("createTurnExtractionBatch");
  });

  it("retains turn-bound memory sources while HITL is parked", async () => {
    const source = await readFile(TELEGRAM_CHANNEL_PATH, "utf8");
    const turnCompleted = source.slice(
      source.indexOf('async "turn.completed"'),
      source.indexOf('async "authorization.required"'),
    );
    const reviewCompletion = turnCompleted.indexOf("await memoryReviewRepository.completeBatch(");
    const sourceRelease = turnCompleted.indexOf("await releaseMemoryTurnSources(ctx)");

    expect(source).toContain("await bindMemoryTurnSources(ctx)");
    expect(turnCompleted).toContain("if (!awaitingApproval) {");
    expect(reviewCompletion).toBeGreaterThan(-1);
    expect(sourceRelease).toBeGreaterThan(reviewCompletion);
  });
});
