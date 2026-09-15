/**
 * Durable Telegram ingress coordinator tests.
 *
 * Constructs covered:
 * - Webhook ACK waits only for persistence, never voice transcription or Eve execution.
 * - External media is acknowledged without entering the durable queue or native dispatch.
 * - Voice results persist once before native Eve dispatch.
 * - Captionless attachments receive a non-empty factual model message after durable storage.
 * - FIFO releases at a waiting boundary even though the durable session stream remains open.
 * - Reused Eve sessions start at the persisted stream cursor and ignore an old waiting boundary.
 * - A callback whose approval settles while other prompts stay unanswered completes at once.
 * - Chats drain in parallel up to a bound; one long turn never holds every other chat.
 * - A rich message (Bot API 10.1) reaches dispatch with its text unfolded from the blocks.
 * - A turn silent for a lease, or a stream closed without a boundary, fails and rotates the session.
 * - Button presses have their own small drain pool, so long model turns cannot hold them.
 */
import type { TelegramVerifiedUpdateContext } from "eve/channels/telegram";
import { parseTelegramUpdate } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import type { TelegramIngressRepository } from "./telegram-ingress-contract.js";
import { createTelegramDurableIngress } from "./telegram-durable-ingress.js";

const BOUNDARY_SETTLEMENT_TIMEOUT_MILLISECONDS = 100;

function voicePayload(): Record<string, unknown> {
  return {
    message: {
      chat: { id: 101, type: "private" },
      date: 1_700_000_000,
      from: { first_name: "Анна", id: 101, is_bot: false },
      message_id: 77,
      voice: {
        file_id: "voice-file-1",
        file_size: 512,
        mime_type: "audio/ogg",
      },
    },
    update_id: 1001,
  };
}

function repository() {
  const claim = {
    attemptCount: 1,
    deliveryContinuationKey: "101::",
    ingressContinuationKey: "101::",
    leaseExpiresAt: new Date(Date.now() + 60_000),
    leaseToken: "123e4567-e89b-42d3-a456-426614174000",
    payload: voicePayload(),
    queueId: "123e4567-e89b-42d3-a456-426614174001",
    transcript: null,
    updateId: "1001",
    voice: { fileId: "voice-file-1", fileSize: 512, mimeType: "audio/ogg" },
  };
  return {
    claim,
    value: {
      acceptMedia: vi.fn().mockResolvedValue(true),
      beginDispatch: vi.fn(),
      beginVoiceTranscription: vi.fn().mockResolvedValue("started"),
      claimFollowing: vi.fn().mockResolvedValue([]),
      claimNext: vi.fn().mockResolvedValueOnce(claim).mockResolvedValueOnce(null),
      complete: vi.fn(),
      completeWithSession: vi.fn(),
      enqueue: vi.fn().mockResolvedValue("inserted"),
      fail: vi.fn(),
      hasPendingApprovals: vi.fn().mockResolvedValue(false),
      hasPendingApprovalsInChat: vi.fn().mockResolvedValue(false),
      listPendingAfter: vi.fn().mockResolvedValue([]),
      rekeyQueue: vi.fn(),
      release: vi.fn(),
      releaseStaleLeases: vi.fn().mockResolvedValue(0),
      renewLease: vi.fn(),
      sessionEventStreamCursor: vi.fn().mockResolvedValue(0),
      saveVoiceTranscript: vi.fn(),
    } satisfies TelegramIngressRepository,
  };
}

describe("createTelegramDurableIngress", () => {
  it("releases leases left by a previous process once, before the first claim of this process", async () => {
    const storage = repository();
    storage.value.claimNext.mockReset().mockResolvedValue(null);
    storage.value.releaseStaleLeases.mockResolvedValue(1);
    const handle = createTelegramDurableIngress({
      acceptMedia: vi.fn().mockResolvedValue(true),
      authorizeVoice: vi.fn().mockResolvedValue(true),
      botUsername: "osinara_bot",
      handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false),
      leaseMilliseconds: 60_000,
      repository: storage.value,
      requestSessionRotation: vi.fn(),
      transcribeVoice: vi.fn(),
    });
    const tasks: Promise<unknown>[] = [];
    const context = { dispatch: vi.fn(), waitUntil: (task: Promise<unknown>) => tasks.push(task) } as never;

    await handle.drain(context);
    await Promise.all(tasks);
    await handle.drain(context);
    await Promise.all(tasks);

    expect(storage.value.releaseStaleLeases).toHaveBeenCalledTimes(1);
    expect(storage.value.claimNext).toHaveBeenCalledTimes(2);
    expect(storage.value.releaseStaleLeases.mock.invocationCallOrder[0]!)
      .toBeLessThan(storage.value.claimNext.mock.invocationCallOrder[0]!);
  });

  it("acknowledges after enqueue and processes voice in the background", async () => {
    const storage = repository();
    const transcribeVoice = vi.fn().mockResolvedValue("Купи молоко");
    let sessionStreamController: ReadableStreamDefaultController<{ type: string }> | undefined;
    const dispatch = vi.fn().mockResolvedValue({
      getEventStream: async () =>
        new ReadableStream({
          start(controller) {
            sessionStreamController = controller;
            controller.enqueue({ type: "session.waiting" });
          },
        }),
      id: "session-1",
    });
    let backgroundTask: Promise<unknown> | undefined;
    const raw = voicePayload();
    const update = parseTelegramUpdate(raw);
    if (!update) throw new Error("AGENT_TEST_TELEGRAM_UPDATE_INVALID: Не создано тестовое обновление");
    const handle = createTelegramDurableIngress({
      acceptMedia: vi.fn().mockResolvedValue(true),
      authorizeVoice: vi.fn().mockResolvedValue(true),
      botUsername: "osinara_bot",
      handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false),
      leaseMilliseconds: 60_000,
      repository: storage.value,
      requestSessionRotation: vi.fn(),
      transcribeVoice,
    });

    const response = await handle({
      dispatch,
      raw,
      update,
      waitUntil(task) {
        backgroundTask = task;
      },
    } as TelegramVerifiedUpdateContext);

    expect(response.status).toBe(200);
    expect(storage.value.enqueue).toHaveBeenCalledTimes(1);
    expect(transcribeVoice).not.toHaveBeenCalled();
    if (!backgroundTask) {
      throw new Error("AGENT_TEST_BACKGROUND_TASK_MISSING: Durable ingress did not schedule a drain");
    }

    // Eve keeps the durable stream open for future turns, so waiting must itself settle the drain.
    const settledAtBoundary = await Promise.race([
      backgroundTask.then(() => true),
      new Promise<false>((resolve) => {
        setTimeout(() => resolve(false), BOUNDARY_SETTLEMENT_TIMEOUT_MILLISECONDS);
      }),
    ]);
    if (!settledAtBoundary) {
      sessionStreamController?.close();
      await backgroundTask;
    }

    expect(settledAtBoundary).toBe(true);
    expect(transcribeVoice).toHaveBeenCalledTimes(1);
    expect(storage.value.beginVoiceTranscription).toHaveBeenCalledWith(
      "1001",
      storage.claim.leaseToken,
    );
    expect(storage.value.saveVoiceTranscript).toHaveBeenCalledWith(
      "1001",
      storage.claim.leaseToken,
      "Купи молоко",
    );
    expect(dispatch.mock.calls[0]?.[0].message.text).toBe("Купи молоко");
    expect(storage.value.beginDispatch).toHaveBeenCalledWith(
      "1001",
      storage.claim.leaseToken,
    );
    expect(storage.value.completeWithSession).toHaveBeenCalledWith(
      "1001",
      storage.claim.leaseToken,
      "session-1",
      1,
    );
  });

  it("does not let an old session.waiting complete a newly dispatched turn", async () => {
    const storage = repository();
    storage.value.sessionEventStreamCursor.mockResolvedValue(2);
    const requestedStartIndexes: number[] = [];
    const dispatch = vi.fn().mockResolvedValue({
      getEventStream: async (options?: { startIndex?: number }) => {
        requestedStartIndexes.push(options?.startIndex ?? 0);
        return new ReadableStream({
          start(controller) {
            // The old waiting event is at index 1 and must be excluded by startIndex=2.
            controller.enqueue({ type: "turn.started" });
            controller.enqueue({ type: "turn.completed" });
            controller.enqueue({ type: "session.waiting" });
          },
        });
      },
      id: "session-reused",
    });
    const raw = voicePayload();
    const update = parseTelegramUpdate(raw);
    if (!update) throw new Error("AGENT_TEST_TELEGRAM_UPDATE_INVALID: Не создано тестовое обновление");
    const handle = createTelegramDurableIngress({
      acceptMedia: vi.fn().mockResolvedValue(true),
      authorizeVoice: vi.fn().mockResolvedValue(false),
      botUsername: "osinara_bot",
      handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false),
      leaseMilliseconds: 60_000,
      repository: storage.value,
      requestSessionRotation: vi.fn(),
      transcribeVoice: vi.fn(),
    });
    let backgroundTask: Promise<unknown> | undefined;

    await handle({
      dispatch,
      raw,
      update,
      waitUntil(task) {
        backgroundTask = task;
      },
    } as TelegramVerifiedUpdateContext);
    await backgroundTask;

    expect(requestedStartIndexes).toEqual([2]);
    expect(storage.value.completeWithSession).toHaveBeenCalledWith(
      "1001",
      storage.claim.leaseToken,
      "session-reused",
      5,
    );
  });

  it("releases a callback dispatch when Eve settles an approval without resuming the turn", async () => {
    const storage = repository();
    const raw = {
      callback_query: {
        chat_instance: "1",
        data: "eve:0",
        from: { first_name: "Анна", id: 101, is_bot: false },
        id: "cb-1",
        message: {
          chat: { id: 101, type: "private" },
          date: 1_700_000_000,
          from: { first_name: "Мия", id: 7, is_bot: true },
          message_id: 88,
          text: "Подтвердите действие",
        },
      },
      update_id: 1002,
    };
    storage.claim.payload = raw;
    storage.claim.updateId = "1002";
    storage.claim.voice = null as never;
    const update = parseTelegramUpdate(raw);
    if (!update) throw new Error("AGENT_TEST_TELEGRAM_UPDATE_INVALID: Не создано тестовое обновление");
    storage.value.hasPendingApprovals.mockResolvedValue(true);
    const dispatch = vi.fn().mockResolvedValue({
      getEventStream: async () =>
        new ReadableStream({
          start(controller) {
            // A partially answered batch settles one approval and then stays parked forever.
            controller.enqueue({ type: "approval.settled" });
          },
        }),
      id: "session-parked",
    });
    const logged = vi.spyOn(console, "info").mockImplementation(() => {});
    const handle = createTelegramDurableIngress({
      acceptMedia: vi.fn().mockResolvedValue(true),
      authorizeVoice: vi.fn(),
      botUsername: "osinara_bot",
      handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false),
      leaseMilliseconds: 60_000,
      repository: storage.value,
      requestSessionRotation: vi.fn(),
      transcribeVoice: vi.fn(),
    });
    let backgroundTask: Promise<unknown> | undefined;

    await handle({
      dispatch,
      raw,
      update,
      waitUntil(task) {
        backgroundTask = task;
      },
    } as TelegramVerifiedUpdateContext);
    const released = await Promise.race([
      backgroundTask!.then(() => true),
      new Promise<false>((resolve) => {
        setTimeout(() => resolve(false), 1_000);
      }),
    ]);

    expect(released).toBe(true);
    expect(storage.value.completeWithSession).toHaveBeenCalledWith(
      "1002",
      storage.claim.leaseToken,
      "session-parked",
      1,
    );
    expect(storage.value.hasPendingApprovals).toHaveBeenCalledWith("session-parked");
    expect(logged.mock.calls.some(([line]) =>
      String(line).includes("AGENT_TELEGRAM_APPROVAL_BATCH_PENDING"))).toBe(true);
    logged.mockRestore();
  });

  it("keeps waiting for the boundary when a settled approval resumes the turn", async () => {
    const storage = repository();
    const raw = {
      callback_query: {
        chat_instance: "1",
        data: "eve:0",
        from: { first_name: "Анна", id: 101, is_bot: false },
        id: "cb-2",
        message: {
          chat: { id: 101, type: "private" },
          date: 1_700_000_000,
          from: { first_name: "Мия", id: 7, is_bot: true },
          message_id: 88,
          text: "Подтвердите действие",
        },
      },
      update_id: 1003,
    };
    storage.claim.payload = raw;
    storage.claim.updateId = "1003";
    storage.claim.voice = null as never;
    const update = parseTelegramUpdate(raw);
    if (!update) throw new Error("AGENT_TEST_TELEGRAM_UPDATE_INVALID: Не создано тестовое обновление");
    const dispatch = vi.fn().mockResolvedValue({
      getEventStream: async () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "approval.settled" });
            controller.enqueue({ type: "input.resolved" });
            controller.enqueue({ type: "turn.started" });
            setTimeout(() => {
              controller.enqueue({ type: "turn.completed" });
              controller.enqueue({ type: "session.waiting" });
            }, 60);
          },
        }),
      id: "session-resumed",
    });
    const handle = createTelegramDurableIngress({
      acceptMedia: vi.fn().mockResolvedValue(true),
      authorizeVoice: vi.fn(),
      botUsername: "osinara_bot",
      handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false),
      leaseMilliseconds: 60_000,
      repository: storage.value,
      requestSessionRotation: vi.fn(),
      transcribeVoice: vi.fn(),
    });
    let backgroundTask: Promise<unknown> | undefined;

    await handle({
      dispatch,
      raw,
      update,
      waitUntil(task) {
        backgroundTask = task;
      },
    } as TelegramVerifiedUpdateContext);
    await backgroundTask;

    expect(storage.value.completeWithSession).toHaveBeenCalledWith(
      "1003",
      storage.claim.leaseToken,
      "session-resumed",
      5,
    );
  });

  it("fails a turn whose session goes silent for a lease and rotates that session", async () => {
    const storage = repository();
    Object.assign(storage.claim, { payload: seriesRaw(6001, "Хомка, ты тут?"), updateId: "6001", voice: null });
    const cancel = vi.fn();
    const dispatch = vi.fn().mockResolvedValue({
      // The turn started but never reports waiting, completion or failure.
      getEventStream: async () => new ReadableStream({ cancel, start(c) { c.enqueue({ type: "turn.started" }); } }),
      id: "session-silent",
    });
    const requestSessionRotation = vi.fn();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const handle = createTelegramDurableIngress({
      acceptMedia: vi.fn().mockResolvedValue(true),
      authorizeVoice: vi.fn(),
      botUsername: "osinara_bot",
      handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false),
      leaseMilliseconds: 120,
      repository: storage.value,
      requestSessionRotation,
      transcribeVoice: vi.fn(),
    });
    const tasks: Promise<unknown>[] = [];
    await handle.drain({ dispatch, waitUntil: (task: Promise<unknown>) => tasks.push(task) } as never);
    const settled = await Promise.race([
      Promise.allSettled(tasks).then(() => true),
      new Promise<false>((resolve) => { setTimeout(() => resolve(false), 1_500); }),
    ]);
    logged.mockRestore();

    expect(settled).toBe(true);
    expect(cancel).toHaveBeenCalled();
    expect(storage.value.completeWithSession).not.toHaveBeenCalled();
    expect(storage.value.fail).toHaveBeenCalledWith("6001", storage.claim.leaseToken, expect.objectContaining({
      code: "AGENT_TELEGRAM_SESSION_BOUNDARY_TIMEOUT",
    }));
    expect(requestSessionRotation).toHaveBeenCalledWith("session-silent");
    // No automatic re-dispatch of an ambiguous start: the update is terminal, not released.
    expect(storage.value.release).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("rotates the session when its stream closes without a boundary", async () => {
    const storage = repository();
    Object.assign(storage.claim, { payload: seriesRaw(6002, "Хомка, привет"), updateId: "6002", voice: null });
    const dispatch = vi.fn().mockResolvedValue({
      getEventStream: async () => new ReadableStream({ start(c) { c.close(); } }),
      id: "session-closed",
    });
    const requestSessionRotation = vi.fn();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const handle = createTelegramDurableIngress({
      acceptMedia: vi.fn().mockResolvedValue(true),
      authorizeVoice: vi.fn(),
      botUsername: "osinara_bot",
      handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false),
      leaseMilliseconds: 60_000,
      repository: storage.value,
      requestSessionRotation,
      transcribeVoice: vi.fn(),
    });
    const tasks: Promise<unknown>[] = [];
    await handle.drain({ dispatch, waitUntil: (task: Promise<unknown>) => tasks.push(task) } as never);
    await Promise.allSettled(tasks);
    logged.mockRestore();

    expect(storage.value.fail).toHaveBeenCalledWith("6002", storage.claim.leaseToken, expect.objectContaining({
      code: "AGENT_TELEGRAM_SESSION_BOUNDARY_MISSING",
    }));
    expect(requestSessionRotation).toHaveBeenCalledWith("session-closed");
  });

  it("drains different chats in parallel while one turn is still running", async () => {
    const storage = repository();
    const first = { ...storage.claim, ingressContinuationKey: "101::", updateId: "1001" };
    const second = {
      ...storage.claim,
      deliveryContinuationKey: "102::",
      ingressContinuationKey: "102::",
      payload: { ...voicePayload(), message: { ...(voicePayload().message as object), chat: { id: 102, type: "private" } }, update_id: 1002 },
      queueId: "123e4567-e89b-42d3-a456-426614174002",
      updateId: "1002",
    };
    storage.value.claimNext.mockReset()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockResolvedValue(null);
    let releaseFirstTurn: (() => void) | undefined;
    const firstTurnReleased = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve;
    });
    const dispatched: string[] = [];
    const dispatch = vi.fn().mockImplementation(async (update: { message: { chat: { id: number } } }) => {
      const chatId = String(update.message.chat.id);
      dispatched.push(chatId);
      return {
        getEventStream: async () =>
          new ReadableStream({
            async start(controller) {
              // Chat 101 stays busy until the test releases it; chat 102 answers at once.
              if (chatId === "101") await firstTurnReleased;
              controller.enqueue({ type: "session.waiting" });
            },
          }),
        id: `session-${chatId}`,
      };
    });
    const handle = createTelegramDurableIngress({
      acceptMedia: vi.fn().mockResolvedValue(true),
      authorizeVoice: vi.fn().mockResolvedValue(false),
      botUsername: "osinara_bot",
      handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false),
      leaseMilliseconds: 60_000,
      maxConcurrentDrains: 2,
      repository: storage.value,
      requestSessionRotation: vi.fn(),
      transcribeVoice: vi.fn(),
    });
    const tasks: Promise<unknown>[] = [];
    const context = { dispatch, waitUntil: (task: Promise<unknown>) => tasks.push(task) } as never;

    await handle.drain(context);
    await handle.drain(context);
    const secondCompleted = await Promise.race([
      new Promise<boolean>((resolve) => {
        const poll = setInterval(() => {
          if (storage.value.completeWithSession.mock.calls.some(([id]) => id === "1002")) {
            clearInterval(poll);
            resolve(true);
          }
        }, 5);
      }),
      new Promise<false>((resolve) => {
        setTimeout(() => resolve(false), 500);
      }),
    ]);
    releaseFirstTurn!();
    await Promise.all(tasks);

    expect(dispatched).toEqual(["101", "102"]);
    expect(secondCompleted).toBe(true);
    expect(storage.value.completeWithSession).toHaveBeenCalledWith(
      "1001",
      storage.claim.leaseToken,
      "session-101",
      1,
    );
  });

  it("answers a button press while every message drain is held by a long turn", async () => {
    const storage = repository();
    const turnClaim = (updateId: string, chatId: number) => ({
      ...storage.claim,
      payload: { ...seriesRaw(Number(updateId), "Хомка, подумай"), message: { ...seriesRaw(Number(updateId), "Хомка, подумай").message, chat: { id: chatId, type: "private" } } },
      queueId: `123e4567-e89b-42d3-a456-4266141740${updateId.slice(-2)}`,
      updateId,
      voice: null,
    });
    const pressClaim = {
      ...storage.claim,
      payload: {
        callback_query: {
          chat_instance: "1",
          data: "eve:0",
          from: { first_name: "Анна", id: 303, is_bot: false },
          id: "cb-press",
          message: { chat: { id: 303, type: "private" }, date: 1_700_000_000, message_id: 90, text: "Подтвердите" },
        },
        update_id: 7003,
      },
      queueId: "123e4567-e89b-42d3-a456-426614174099",
      updateId: "7003",
      voice: null,
    };
    const turns = [turnClaim("7001", 101), turnClaim("7002", 202)];
    const presses = [pressClaim];
    storage.value.claimNext = vi.fn(async (_lease: number, options?: { callbackOnly?: boolean }) =>
      options?.callbackOnly ? presses.shift() ?? null : turns.shift() ?? presses.shift() ?? null);
    let releaseTurns!: () => void;
    const turnsReleased = new Promise<void>((resolve) => { releaseTurns = resolve; });
    const dispatch = vi.fn(async (update: { kind: string }) => ({
      getEventStream: async () => new ReadableStream({
        async start(controller) {
          // Model turns stay busy; the resumed approval step reports its boundary at once.
          if (update.kind === "message") await turnsReleased;
          controller.enqueue({ type: "session.waiting" });
        },
      }),
      id: `session-${update.kind}`,
    }));
    const handle = createTelegramDurableIngress({
      acceptMedia: vi.fn().mockResolvedValue(true),
      authorizeVoice: vi.fn(),
      botUsername: "osinara_bot",
      handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false),
      leaseMilliseconds: 60_000,
      maxConcurrentCallbackDrains: 1,
      maxConcurrentDrains: 2,
      repository: storage.value,
      requestSessionRotation: vi.fn(),
      transcribeVoice: vi.fn(),
    });
    const tasks: Promise<unknown>[] = [];
    const context = { dispatch, waitUntil: (task: Promise<unknown>) => tasks.push(task) } as never;

    await handle.drain(context);
    await handle.drain(context);
    await handle.drain(context);
    const pressCompleted = await vi.waitFor(() => {
      expect(storage.value.completeWithSession).toHaveBeenCalledWith("7003", storage.claim.leaseToken, "session-callback_query", 1);
    }, { interval: 5, timeout: 500 }).then(() => true, () => false);
    releaseTurns();
    await Promise.all(tasks);

    expect(pressCompleted).toBe(true);
    expect(storage.value.completeWithSession.mock.calls.map((call) => call[0]).sort()).toEqual(["7001", "7002", "7003"]);
  });

  it("dispatches another bot's rich message with the text unfolded from its blocks", async () => {
    const storage = repository();
    const raw = {
      message: {
        chat: { id: -1000000005, title: "Bot arena", type: "group" },
        date: 1_788_563_816,
        from: { first_name: "Osinara", id: 8_748_025_221, is_bot: true, username: "osinara_bot" },
        message_id: 557,
        rich_message: {
          blocks: [{
            blocks: [{ text: "Скрытая часть ответа другого бота.", type: "paragraph" }],
            summary: "Полный ответ",
            type: "details",
          }],
        },
      },
      update_id: 1004,
    };
    storage.claim.payload = raw;
    storage.claim.updateId = "1004";
    storage.claim.voice = null as never;
    const update = parseTelegramUpdate(raw);
    if (!update) throw new Error("AGENT_TEST_TELEGRAM_UPDATE_INVALID: Не создано тестовое обновление");
    const dispatch = vi.fn().mockResolvedValue({
      getEventStream: async () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "session.waiting" });
          },
        }),
      id: "session-rich",
    });
    const handle = createTelegramDurableIngress({
      acceptMedia: vi.fn().mockResolvedValue(true),
      authorizeVoice: vi.fn(),
      botUsername: "osinara_bot",
      handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false),
      leaseMilliseconds: 60_000,
      repository: storage.value,
      requestSessionRotation: vi.fn(),
      transcribeVoice: vi.fn(),
    });
    let backgroundTask: Promise<unknown> | undefined;

    await handle({
      dispatch,
      raw,
      update,
      waitUntil(task) {
        backgroundTask = task;
      },
    } as TelegramVerifiedUpdateContext);
    await backgroundTask;

    expect(dispatch.mock.calls[0]?.[0].message.text).toBe("Полный ответ\n\nСкрытая часть ответа другого бота.");
  });

  function seriesRaw(
    updateId: number,
    text: string,
    from: { first_name: string; id: number; is_bot: boolean; username?: string } = { first_name: "Пух", id: 202, is_bot: false, username: "nyxandro" },
  ) {
    return {
      message: {
        chat: { id: -1000000005, title: "Bot arena", type: "group" },
        date: 1_788_563_816 + updateId,
        from,
        message_id: updateId,
        text,
      },
      update_id: updateId,
    };
  }

  function seriesClaim(storage: ReturnType<typeof repository>, updateId: number, text: string) {
    return {
      ...storage.claim,
      leaseToken: `123e4567-e89b-42d3-a456-4266141740${String(updateId).slice(-2)}`,
      payload: seriesRaw(updateId, text),
      transcript: null,
      updateId: String(updateId),
      voice: null,
    };
  }

  function seriesIngress(storage: ReturnType<typeof repository>, dispatch: ReturnType<typeof vi.fn>) {
    return createTelegramDurableIngress({
      acceptMedia: vi.fn().mockResolvedValue(true),
      authorizeVoice: vi.fn(),
      botUsername: "osinara_bot",
      handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false),
      leaseMilliseconds: 60_000,
      repository: storage.value,
      requestSessionRotation: vi.fn(),
      transcribeVoice: vi.fn(),
    });
  }

  it("answers consecutive messages of one author in a single turn started by the last one", async () => {
    const storage = repository();
    const head = seriesClaim(storage, 2001, "Хомка, смотри");
    const second = seriesClaim(storage, 2002, "вот первый пункт");
    const third = seriesClaim(storage, 2003, "и второй");
    storage.claim.payload = head.payload;
    storage.claim.updateId = head.updateId;
    storage.claim.voice = null as never;
    storage.value.claimNext = vi.fn().mockResolvedValueOnce(head).mockResolvedValueOnce(null);
    // The repository applies the predicate in queue order; a message from someone else ends the run.
    storage.value.claimFollowing = vi.fn(async (input: { accept: (payload: Record<string, unknown>) => boolean }) => {
      const candidates = [
        second,
        third,
        { ...seriesClaim(storage, 2004, "а я тут"), payload: seriesRaw(2004, "а я тут", { first_name: "Илья", id: 303, is_bot: false }) },
      ];
      const accepted = [];
      for (const candidate of candidates) {
        if (!input.accept(candidate.payload)) break;
        accepted.push(candidate);
      }
      return accepted;
    });
    const dispatch = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      getEventStream: async () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "session.waiting" });
          },
        }),
      id: "session-series",
    });
    const handle = seriesIngress(storage, dispatch);
    const update = parseTelegramUpdate(head.payload);
    if (!update) throw new Error("AGENT_TEST_TELEGRAM_UPDATE_INVALID: Не создано тестовое обновление");
    let backgroundTask: Promise<unknown> | undefined;

    await handle({
      dispatch,
      raw: head.payload,
      update,
      waitUntil(task) {
        backgroundTask = task;
      },
    } as TelegramVerifiedUpdateContext);
    await backgroundTask;

    expect(storage.value.claimFollowing).toHaveBeenCalledWith(expect.objectContaining({
      afterUpdateId: "2001",
      limit: 4,
      queueId: storage.claim.queueId,
    }));
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(dispatch.mock.calls.map((call) => call[0].message.text)).toEqual([
      "Хомка, смотри",
      "вот первый пункт",
      "и второй",
    ]);
    expect(dispatch.mock.calls[0]?.[0].message.raw.osinara_series).toEqual({ role: "context" });
    expect(dispatch.mock.calls[1]?.[0].message.raw.osinara_series).toEqual({ role: "context" });
    expect(dispatch.mock.calls[2]?.[0].message.raw.osinara_series).toEqual({
      addressed: true,
      role: "current",
      telegramMessageIds: ["2001", "2002"],
    });
    expect(storage.value.beginDispatch.mock.calls.map((call) => call[0])).toEqual(["2001", "2002", "2003"]);
    expect(storage.value.complete.mock.calls.map((call) => call[0])).toEqual(["2001", "2002"]);
    expect(storage.value.completeWithSession).toHaveBeenCalledWith("2003", third.leaseToken, "session-series", 1);
    expect(storage.value.fail).not.toHaveBeenCalled();
  });

  it("hands the turn the queue tail that arrived after its message", async () => {
    const storage = repository();
    const head = seriesClaim(storage, 4001, "Хомка, что скажешь?");
    storage.claim.payload = head.payload;
    storage.claim.updateId = head.updateId;
    storage.claim.voice = null as never;
    storage.value.claimNext = vi.fn().mockResolvedValueOnce(head).mockResolvedValueOnce(null);
    storage.value.listPendingAfter = vi.fn().mockResolvedValue([
      { payload: seriesRaw(4002, "уже вписала", { first_name: "Осинара", id: 777, is_bot: true, username: "osinara_bot" }), receivedAt: new Date("2026-09-05T22:20:00Z") },
      { payload: seriesRaw(4003, "и я тут", { first_name: "Илья", id: 303, is_bot: false }), receivedAt: new Date("2026-09-05T22:21:00Z") },
    ]);
    const dispatch = vi.fn().mockResolvedValueOnce({
      getEventStream: async () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "session.waiting" });
          },
        }),
      id: "session-pending",
    });
    const handle = seriesIngress(storage, dispatch);
    const update = parseTelegramUpdate(head.payload);
    if (!update) throw new Error("AGENT_TEST_TELEGRAM_UPDATE_INVALID: Не создано тестовое обновление");
    let backgroundTask: Promise<unknown> | undefined;

    await handle({
      dispatch,
      raw: head.payload,
      update,
      waitUntil(task) {
        backgroundTask = task;
      },
    } as TelegramVerifiedUpdateContext);
    await backgroundTask;

    expect(storage.value.listPendingAfter).toHaveBeenCalledWith({
      afterUpdateId: "4001", limit: 10, queueId: storage.claim.queueId,
    });
    expect(dispatch.mock.calls[0]?.[0].message.raw.osinara_pending).toEqual([
      expect.objectContaining({ isBot: true, messageId: "4002", senderName: "osinara_bot", text: "уже вписала" }),
      expect.objectContaining({ isBot: false, messageId: "4003", senderName: "Илья", text: "и я тут" }),
    ]);
    // The queue tail is only read, never leased: those messages keep their own turns.
    expect(storage.value.beginDispatch.mock.calls.map((call) => call[0])).toEqual(["4001"]);
  });

  it("stops a series member's heartbeat before its completion so a long last turn survives", async () => {
    const storage = repository();
    const head = seriesClaim(storage, 5001, "первое");
    const second = seriesClaim(storage, 5002, "Хомка, второе");
    storage.claim.payload = head.payload;
    storage.claim.updateId = head.updateId;
    storage.claim.voice = null as never;
    storage.value.claimNext = vi.fn().mockResolvedValueOnce(head).mockResolvedValueOnce(null);
    storage.value.claimFollowing = vi.fn().mockResolvedValue([second]);
    const completed = new Set<string>();
    storage.value.complete = vi.fn(async (updateId: string) => {
      completed.add(updateId);
    });
    // A released lease cannot be renewed: the repository fails the way production does.
    storage.value.renewLease = vi.fn(async (updateId: string) => {
      if (completed.has(updateId)) throw new Error("AGENT_TELEGRAM_INGRESS_LEASE_LOST");
      return new Date(Date.now() + 300);
    });
    // The last turn outlives several heartbeat ticks (lease 300 ms, tick every 100 ms).
    const dispatch = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      getEventStream: async () =>
        new ReadableStream({
          start(controller) {
            // The turn keeps streaming, so the silent-lease bound never cuts it.
            for (const at of [100, 200, 300, 400]) {
              setTimeout(() => controller.enqueue({ type: "message.appended" }), at);
            }
            setTimeout(() => controller.enqueue({ type: "session.waiting" }), 450);
          },
        }),
      id: "session-long",
    });
    const handle = createTelegramDurableIngress({
      acceptMedia: vi.fn().mockResolvedValue(true),
      authorizeVoice: vi.fn(),
      botUsername: "osinara_bot",
      handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false),
      leaseMilliseconds: 300,
      repository: storage.value,
      requestSessionRotation: vi.fn(),
      transcribeVoice: vi.fn(),
    });
    const update = parseTelegramUpdate(head.payload);
    if (!update) throw new Error("AGENT_TEST_TELEGRAM_UPDATE_INVALID: Не создано тестовое обновление");
    let backgroundTask: Promise<unknown> | undefined;

    await handle({
      dispatch,
      raw: head.payload,
      update,
      waitUntil(task) {
        backgroundTask = task;
      },
    } as TelegramVerifiedUpdateContext);
    await backgroundTask;

    expect(storage.value.completeWithSession).toHaveBeenCalledWith("5002", second.leaseToken, "session-long", 5);
    expect(storage.value.fail).not.toHaveBeenCalled();
    expect(storage.value.renewLease.mock.calls.map((call) => call[0])).not.toContain("5001");
  });

  it("fails the rest of a series when one dispatch throws and keeps the finished part completed", async () => {
    const storage = repository();
    const head = seriesClaim(storage, 3001, "первое");
    const second = seriesClaim(storage, 3002, "второе");
    const third = seriesClaim(storage, 3003, "Хомка, третье");
    storage.value.claimNext = vi.fn().mockResolvedValueOnce(head).mockResolvedValueOnce(null);
    storage.value.claimFollowing = vi.fn().mockResolvedValue([second, third]);
    const dispatch = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("AGENT_TEST_DISPATCH_FAILED: сбой"));
    const handle = seriesIngress(storage, dispatch);
    const update = parseTelegramUpdate(head.payload);
    if (!update) throw new Error("AGENT_TEST_TELEGRAM_UPDATE_INVALID: Не создано тестовое обновление");
    let backgroundTask: Promise<unknown> | undefined;

    await handle({
      dispatch,
      raw: head.payload,
      update,
      waitUntil(task) {
        backgroundTask = task;
      },
    } as TelegramVerifiedUpdateContext);
    await expect(backgroundTask).rejects.toThrowError(/AGENT_TEST_DISPATCH_FAILED/u);

    expect(storage.value.complete.mock.calls.map((call) => call[0])).toEqual(["3001"]);
    expect(storage.value.fail.mock.calls.map((call) => call[0])).toEqual(["3002", "3003"]);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("leaves a message alone while the chat has an unanswered confirmation", async () => {
    const storage = repository();
    const head = seriesClaim(storage, 4001, "Хомка, да");
    storage.value.claimNext = vi.fn().mockResolvedValueOnce(head).mockResolvedValueOnce(null);
    storage.value.hasPendingApprovalsInChat = vi.fn().mockResolvedValue(true);
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const handle = seriesIngress(storage, dispatch);
    const update = parseTelegramUpdate(head.payload);
    if (!update) throw new Error("AGENT_TEST_TELEGRAM_UPDATE_INVALID: Не создано тестовое обновление");
    let backgroundTask: Promise<unknown> | undefined;

    await handle({
      dispatch,
      raw: head.payload,
      update,
      waitUntil(task) {
        backgroundTask = task;
      },
    } as TelegramVerifiedUpdateContext);
    await backgroundTask;

    expect(storage.value.hasPendingApprovalsInChat).toHaveBeenCalledWith("-1000000005");
    expect(storage.value.claimFollowing).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0].message.raw.osinara_series).toBeUndefined();
  });

  it("acknowledges rejected external media without enqueue, download, or dispatch", async () => {
    const storage = repository();
    storage.value.claimNext.mockReset().mockResolvedValue(null);
    const acceptMedia = vi.fn().mockResolvedValue(false);
    const transcribeVoice = vi.fn();
    const dispatch = vi.fn();
    const waitUntil = vi.fn();
    const raw = voicePayload();
    const rawMessage = raw.message as Record<string, unknown>;
    rawMessage.chat = { id: -1001, type: "supergroup" };
    const update = parseTelegramUpdate(raw);
    if (!update || update.kind !== "message") {
      throw new Error("AGENT_TEST_TELEGRAM_UPDATE_INVALID: Не создано тестовое сообщение");
    }
    const handle = createTelegramDurableIngress({
      acceptMedia,
      authorizeVoice: vi.fn(),
      botUsername: "osinara_bot",
      handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false),
      leaseMilliseconds: 60_000,
      repository: storage.value,
      requestSessionRotation: vi.fn(),
      transcribeVoice,
    });

    const response = await handle({ dispatch, raw, update, waitUntil } as TelegramVerifiedUpdateContext);

    expect(response.status).toBe(200);
    expect(acceptMedia).toHaveBeenCalledWith(update.message, "1001", "unsupported_media");
    expect(storage.value.enqueue).not.toHaveBeenCalled();
    expect(transcribeVoice).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("dispatches a captionless photo with a non-empty factual model message", async () => {
    const storage = repository();
    const raw = {
      message: {
        chat: { id: 101, type: "private" },
        date: 1_700_000_000,
        from: { first_name: "Анна", id: 101, is_bot: false },
        message_id: 78,
        photo: [{
          file_id: "photo-file-1",
          file_size: 1_024,
          file_unique_id: "photo-unique-1",
          height: 640,
          width: 640,
        }],
      },
      update_id: 1002,
    };
    Object.assign(storage.claim, { payload: raw, updateId: "1002", voice: null });
    const update = parseTelegramUpdate(raw);
    if (!update || update.kind !== "message") {
      throw new Error("AGENT_TEST_TELEGRAM_UPDATE_INVALID: Не создано тестовое сообщение");
    }
    const dispatch = vi.fn().mockResolvedValue(null);
    let backgroundTask: Promise<unknown> | undefined;
    const handle = createTelegramDurableIngress({
      acceptMedia: vi.fn().mockResolvedValue(true),
      authorizeVoice: vi.fn(),
      botUsername: "osinara_bot",
      handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false),
      leaseMilliseconds: 60_000,
      repository: storage.value,
      requestSessionRotation: vi.fn(),
      transcribeVoice: vi.fn(),
    });

    await handle({
      dispatch,
      raw,
      update,
      waitUntil(task) {
        backgroundTask = task;
      },
    } as TelegramVerifiedUpdateContext);
    if (!backgroundTask) {
      throw new Error("AGENT_TEST_BACKGROUND_TASK_MISSING: Durable ingress did not schedule a drain");
    }
    await backgroundTask;

    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      kind: "message",
      message: {
        attachments: [expect.objectContaining({ fileId: "photo-file-1", kind: "photo" })],
        text: "Пользователь отправил файл без подписи.",
      },
    });
    expect((raw.message as Record<string, unknown>).text).toBeUndefined();
  });
});
