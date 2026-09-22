/**
 * Durable Telegram ingress coordinator.
 *
 * Exports:
 * - `createTelegramDurableIngress`: verified Eve hook that persists before ACK and drains FIFO.
 * - `handleTelegramDurableIngress`: production hook with PostgreSQL and Groq dependencies.
 * - Application software-update callbacks complete before native Eve dispatch begins.
 */
import type {
  TelegramDrainContext,
  TelegramMessage,
  TelegramUpdate,
  TelegramVerifiedUpdateContext,
} from "eve/channels/telegram";
import { parseTelegramUpdate } from "eve/channels/telegram";

import { TELEGRAM_INGRESS_LEASE_MS } from "../config.js";
import { AppError, isAppError } from "./app-error.js";
import { transcribeTelegramVoice } from "./groq-voice-transcription.js";
import type { TelegramIngressClaim, TelegramIngressRepository } from "./telegram-ingress-contract.js";
import { telegramIngressRepository } from "./telegram-ingress-repository.js";
import {
  classifyTelegramInboundMedia,
  isMessageAddressedToBot,
  type TelegramInboundMediaKind,
} from "./telegram-message-policy.js";
import { createTelegramVoiceAuthorizer } from "./telegram-voice-authorization.js";
import {
  TELEGRAM_SERIES_MAX_MESSAGES,
  continuesSeries,
  isSeriesEligible,
  type TelegramSeriesMarker,
  withSeriesMarker,
} from "./telegram-message-series.js";
import {
  pendingMessagesFromPayloads,
  TELEGRAM_PENDING_MESSAGES_MAX,
  type TelegramPendingMessage,
  withPendingMarker,
} from "./telegram-pending-messages.js";
import { withRichMessageText } from "./telegram-rich-message.js";
import {
  shouldTranscribeVoice,
  telegramQueueKey,
  telegramUpdateId,
  telegramVoiceMetadata,
  withCaptionlessAttachmentText,
  withTranscript,
} from "./telegram-ingress-update.js";
import { telegramRepository } from "./telegram-repository.js";
import { handleSoftwareUpdateCallback } from "./software-updates/callback.js";
import { sessionRepository } from "./sessions/session-repository.js";
import {
  type EveSessionResult,
  isLostSessionBoundary,
  waitForSessionBoundary,
} from "./telegram-session-boundary.js";

interface DurableIngressDependencies {
  acceptMedia(
    message: Pick<TelegramMessage, "chat">,
    updateId: string,
    mediaKind: Exclude<TelegramInboundMediaKind, "none">,
  ): Promise<boolean>;
  authorizeVoice(message: Pick<TelegramMessage, "chat" | "from">): Promise<boolean>;
  botUsername: string;
  /**
   * Drain loops allowed at once. `claimNext` keeps every chat/topic FIFO on its own, so parallel
   * loops only stop one long turn from holding every other chat and every approval button.
   */
  maxConcurrentDrains?: number;
  /**
   * Extra drain loops that lease only button presses. A press resumes a parked turn and must not
   * wait until one of the message loops, each possibly holding a turn of several minutes, frees up.
   */
  maxConcurrentCallbackDrains?: number;
  handleSoftwareUpdateCallback(
    query: Extract<TelegramUpdate, { kind: "callback_query" }>["callbackQuery"],
  ): Promise<boolean>;
  leaseMilliseconds: number;
  repository: TelegramIngressRepository;
  /**
   * Marks the application session of an Eve session for rotation after its turn boundary was
   * lost: its stream cursor is unknown, so a late event of that turn could close the next message.
   */
  requestSessionRotation(eveSessionId: string): Promise<void>;
  transcribeVoice(input: {
    fileId: string;
    fileSize?: number;
    mimeType?: string;
  }): Promise<string>;
}

interface TelegramDurableIngressHandler {
  (context: TelegramVerifiedUpdateContext): Promise<Response>;
  drain(context: TelegramDrainContext): Promise<Response>;
}

const LEASE_HEARTBEAT_DIVISOR = 3;

const DEFAULT_MAX_CONCURRENT_DRAINS = 3;
const DEFAULT_MAX_CONCURRENT_CALLBACK_DRAINS = 2;

export function createTelegramDurableIngress(dependencies: DurableIngressDependencies) {
  const drainPools = {
    any: {
      active: new Set<Promise<void>>(),
      limit: dependencies.maxConcurrentDrains ?? DEFAULT_MAX_CONCURRENT_DRAINS,
    },
    callback: {
      active: new Set<Promise<void>>(),
      limit: dependencies.maxConcurrentCallbackDrains ?? DEFAULT_MAX_CONCURRENT_CALLBACK_DRAINS,
    },
  };

  async function maintainLease(
    updateId: string,
    leaseToken: string,
    signal: AbortSignal,
  ): Promise<void> {
    const heartbeatMilliseconds = Math.floor(
      dependencies.leaseMilliseconds / LEASE_HEARTBEAT_DIVISOR,
    );
    while (!signal.aborted) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, heartbeatMilliseconds);
        signal.addEventListener("abort", () => {
          clearTimeout(timeout);
          resolve();
        }, { once: true });
      });
      if (signal.aborted) return;
      await dependencies.repository.renewLease(
        updateId,
        leaseToken,
        dependencies.leaseMilliseconds,
      );
    }
  }

  async function rotateLostSession(eveSessionId: string, leasedUpdateId: string): Promise<void> {
    try {
      await dependencies.requestSessionRotation(eveSessionId);
      console.warn(JSON.stringify({
        code: "AGENT_TELEGRAM_SESSION_ROTATION_REQUESTED",
        eveSessionId,
        updateId: leasedUpdateId,
      }));
    } catch (error) {
      // The update still fails with its boundary code; a rotation failure must not replace it.
      console.error(JSON.stringify({
        code: "AGENT_TELEGRAM_SESSION_ROTATION_FAILED",
        error: error instanceof Error ? error.message : String(error),
        eveSessionId,
        updateId: leasedUpdateId,
      }));
    }
  }

  // Leases alive at the first drain of this process were held by a predecessor that died
  // mid-turn; releasing them once lets the affected chats resume in seconds instead of waiting
  // out the full lease. A redispatched update is deduplicated by the journal, so no turn repeats.
  // Every pool waits for the same single release, so no loop claims before it has finished.
  let staleLeasesRelease: Promise<void> | undefined;

  type LeasedUpdate = { claim: TelegramIngressClaim; update: TelegramUpdate };

  // A run of consecutive messages from the author of `head` is leased together so one turn can
  // answer it; anything else stays in the queue and forms the next claim.
  async function claimSeriesFollowers(
    head: TelegramIngressClaim,
    update: TelegramUpdate,
  ): Promise<LeasedUpdate[]> {
    if (!isSeriesEligible(update, dependencies.botUsername) || update.kind !== "message") return [];
    if (await dependencies.repository.hasPendingApprovalsInChat(update.message.chat.id)) return [];
    const followers = await dependencies.repository.claimFollowing({
      accept: (payload) => {
        const candidate = parseTelegramUpdate(payload);
        return candidate !== null &&
          continuesSeries(update, withRichMessageText(candidate), dependencies.botUsername);
      },
      afterUpdateId: head.updateId,
      leaseMilliseconds: dependencies.leaseMilliseconds,
      limit: TELEGRAM_SERIES_MAX_MESSAGES - 1,
      queueId: head.queueId,
    });
    return followers.map((claim) => {
      const parsed = parseTelegramUpdate(claim.payload);
      if (!parsed) {
        throw new AppError(
          "AGENT_TELEGRAM_PAYLOAD_INVALID",
          "Не удалось подготовить сообщение серии для обработки",
        );
      }
      return { claim, update: withRichMessageText(parsed) };
    });
  }

  function seriesMarker(series: readonly LeasedUpdate[], index: number): TelegramSeriesMarker | null {
    if (series.length === 1) return null;
    if (index < series.length - 1) return { role: "context" };
    const messages = series.map((item) => (item.update as { message: TelegramMessage }).message);
    return {
      addressed: messages.some((message) =>
        isMessageAddressedToBot(message, dependencies.botUsername)
      ),
      role: "current",
      telegramMessageIds: messages.slice(0, -1).map((message) => message.messageId),
    };
  }

  async function drain(
    dispatch: TelegramVerifiedUpdateContext["dispatch"],
    pool: keyof typeof drainPools,
  ): Promise<void> {
    staleLeasesRelease ??= dependencies.repository.releaseStaleLeases().then((released) => {
      if (released > 0) {
        console.warn(JSON.stringify({ code: "AGENT_TELEGRAM_INGRESS_LEASES_RELEASED", released }));
      }
    });
    await staleLeasesRelease;
    while (true) {
      const claim = await dependencies.repository.claimNext(
        dependencies.leaseMilliseconds,
        ...(pool === "callback" ? [{ callbackOnly: true }] : []),
      );
      if (!claim) return;
      // One heartbeat per leased update, stopped right before that update's terminal transition:
      // a heartbeat that outlived its completed series member kept renewing a released lease,
      // failed after the next tick, and that failure sank the whole series minutes later.
      const heartbeatControllers = new Map<string, AbortController>();
      let heartbeatError: unknown;
      const heartbeats: Promise<void>[] = [];
      const startHeartbeat = (leased: TelegramIngressClaim): void => {
        const controller = new AbortController();
        heartbeatControllers.set(leased.updateId, controller);
        heartbeats.push(
          maintainLease(leased.updateId, leased.leaseToken, controller.signal)
            .catch((error: unknown) => {
              heartbeatError = error;
            }),
        );
      };
      const stopHeartbeat = (updateId: string): void => {
        heartbeatControllers.get(updateId)?.abort();
        heartbeatControllers.delete(updateId);
      };
      startHeartbeat(claim);
      // Every leased update that has not reached a terminal state yet; a failure marks them all.
      const pending: TelegramIngressClaim[] = [claim];

      async function dispatchLeased(
        leased: TelegramIngressClaim,
        update: TelegramUpdate,
        marker: TelegramSeriesMarker | null,
        pendingAfter: readonly TelegramPendingMessage[],
      ): Promise<void> {
        await dependencies.repository.beginDispatch(leased.updateId, leased.leaseToken);
        const marked = marker !== null && update.kind === "message"
          ? withSeriesMarker(update, marker)
          : update;
        // The turn sees what the chat said after its message: otherwise it answered a snapshot
        // the conversation had already moved past, and two bots went in circles.
        const outbound = pendingAfter.length > 0 && marked.kind === "message"
          ? withPendingMarker(marked, pendingAfter)
          : marked;
        const session = (await dispatch(
          withCaptionlessAttachmentText(outbound),
        )) as EveSessionResult | null | undefined;
        if (!session) {
          stopHeartbeat(leased.updateId);
          await dependencies.repository.complete(leased.updateId, leased.leaseToken);
          return;
        }
        // The durable cursor excludes every event from earlier turns of a reused Eve session.
        const streamCursor = await dependencies.repository.sessionEventStreamCursor(session.id);
        let nextEventIndex: number;
        try {
          nextEventIndex = await waitForSessionBoundary(session, streamCursor, {
            ...(update.kind === "callback_query"
              ? {
                hasPendingApprovals: () =>
                  dependencies.repository.hasPendingApprovals(session.id),
              }
              : {}),
            // One message holds its chat and a drain loop for at most one silent lease.
            idleMilliseconds: dependencies.leaseMilliseconds,
            updateId: leased.updateId,
          });
        } catch (error) {
          if (isLostSessionBoundary(error)) await rotateLostSession(session.id, leased.updateId);
          throw error;
        }
        if (heartbeatError) throw heartbeatError;
        stopHeartbeat(leased.updateId);
        await dependencies.repository.completeWithSession(
          leased.updateId,
          leased.leaseToken,
          session.id,
          nextEventIndex,
        );
      }

      try {
        let payload = claim.payload;
        // Rich messages (Bot API 10.1) carry their text in blocks; Eve reads only `text`.
        let update = parseTelegramUpdate(payload);
        if (update) update = withRichMessageText(update);
        if (!update) {
          await dependencies.repository.complete(claim.updateId, claim.leaseToken);
          pending.shift();
          continue;
        }

        // Application update decisions are durable DB transitions and never enter an Eve session.
        if (
          update.kind === "callback_query" &&
          await dependencies.handleSoftwareUpdateCallback(update.callbackQuery)
        ) {
          await dependencies.repository.complete(claim.updateId, claim.leaseToken);
          pending.shift();
          continue;
        }

        if (claim.voice && update.kind === "message" && shouldTranscribeVoice(update.message)) {
          const authorized = await dependencies.authorizeVoice(update.message);
          if (authorized) {
            if (!claim.transcript) {
              await dependencies.repository.beginVoiceTranscription(
                claim.updateId,
                claim.leaseToken,
              );
            }
            const transcript =
              claim.transcript ?? (await dependencies.transcribeVoice(claim.voice)).trim();
            // В личном чате человек ждёт ответа именно на это сообщение, поэтому пустой
            // транскрипт — понятная ошибка. В группе речь распознаётся ради адресации, и смех или
            // музыка не должны ронять update: иначе сообщение пропадает даже из журнала.
            if (!transcript && update.message.chat.type === "private") {
              throw new AppError(
                "AGENT_VOICE_TRANSCRIPT_EMPTY",
                "В голосовом сообщении не удалось распознать речь. Запишите его ещё раз",
              );
            }
            if (!transcript) {
              console.warn(JSON.stringify({
                code: "AGENT_VOICE_TRANSCRIPT_EMPTY_IN_GROUP",
                chatType: update.message.chat.type,
              }));
            }
            if (transcript) {
              if (!claim.transcript) {
                await dependencies.repository.saveVoiceTranscript(
                  claim.updateId,
                  claim.leaseToken,
                  transcript,
                );
              }
              payload = withTranscript(payload, transcript);
              update = parseTelegramUpdate(payload);
            }
            if (update) update = withRichMessageText(update);
            if (!update) {
              throw new AppError(
                "AGENT_TELEGRAM_PAYLOAD_INVALID",
                "Не удалось подготовить голосовое сообщение для обработки",
              );
            }
          }
        }

        const series: LeasedUpdate[] = [{ claim, update }];
        for (const follower of await claimSeriesFollowers(claim, update)) {
          series.push(follower);
          pending.push(follower.claim);
          startHeartbeat(follower.claim);
        }
        if (series.length > 1) {
          console.info(JSON.stringify({
            code: "AGENT_TELEGRAM_SERIES_CLAIMED",
            messages: series.length,
            updateIds: series.map((item) => item.claim.updateId),
          }));
        }
        const tail = series[series.length - 1]!;
        const pendingAfter = tail.update.kind === "message"
          ? pendingMessagesFromPayloads(await dependencies.repository.listPendingAfter({
            afterUpdateId: tail.claim.updateId,
            limit: TELEGRAM_PENDING_MESSAGES_MAX,
            queueId: tail.claim.queueId,
          }))
          : [];
        for (let index = 0; index < series.length; index += 1) {
          const item = series[index]!;
          const last = index === series.length - 1;
          await dispatchLeased(item.claim, item.update, seriesMarker(series, index), last ? pendingAfter : []);
          pending.shift();
        }
      } catch (error) {
        const failure = {
          code: isAppError(error) ? error.code : "AGENT_TELEGRAM_INGRESS_FAILED",
          message: isAppError(error)
            ? error.message
            : "AGENT_TELEGRAM_INGRESS_FAILED: Не удалось обработать сообщение Telegram",
        };
        console.error(
          JSON.stringify({
            code: failure.code,
            error: error instanceof Error ? error.message : String(error),
            updateId: pending[0]?.updateId ?? claim.updateId,
            ...(pending.length > 1 ? { seriesUpdateIds: pending.map((item) => item.updateId) } : {}),
          }),
        );
        for (const leased of pending) {
          stopHeartbeat(leased.updateId);
          await dependencies.repository.fail(leased.updateId, leased.leaseToken, failure);
        }
        throw error;
      } finally {
        for (const controller of heartbeatControllers.values()) controller.abort();
        await Promise.all(heartbeats);
      }
    }
  }

  function scheduleDrain(context: TelegramDrainContext): void {
    // Each trigger adds at most one loop; a loop ends when no claimable update remains. A message
    // loop also takes button presses, so the callback pool is started only when every message loop
    // is busy, which is exactly when a press would otherwise wait for a long turn to finish.
    const pool = drainPools.any.active.size < drainPools.any.limit
      ? drainPools.any
      : drainPools.callback.active.size < drainPools.callback.limit ? drainPools.callback : null;
    if (pool) {
      const scheduled: Promise<void> = drain(
        context.dispatch,
        pool === drainPools.any ? "any" : "callback",
      ).finally(() => {
        pool.active.delete(scheduled);
      });
      pool.active.add(scheduled);
    }
    for (const running of [...drainPools.any.active, ...drainPools.callback.active]) {
      context.waitUntil(running);
    }
  }

  const handleVerifiedUpdate = async function handleVerifiedUpdate(
    context: TelegramVerifiedUpdateContext,
  ): Promise<Response> {
    const incomingUpdateId = telegramUpdateId(context.raw);
    const mediaKind = context.update.kind === "message"
      ? classifyTelegramInboundMedia(context.update.message)
      : "none";
    // External media is acknowledged before durable storage, download, transcription, or Eve dispatch.
    if (
      context.update.kind === "message" &&
      mediaKind !== "none" &&
      !await dependencies.acceptMedia(context.update.message, incomingUpdateId, mediaKind)
    ) {
      return new Response("ok");
    }
    const voice = telegramVoiceMetadata(context.raw);
    await dependencies.repository.enqueue({
      continuationKey: telegramQueueKey(context.update),
      payload: context.raw,
      updateId: incomingUpdateId,
      ...(voice ? { voice } : {}),
    });
    scheduleDrain(context);
    return new Response("ok");
  };

  // The private poller uses the same native dispatcher without creating a synthetic update.
  handleVerifiedUpdate.drain = async (context: TelegramDrainContext): Promise<Response> => {
    scheduleDrain(context);
    return new Response("ok");
  };
  return handleVerifiedUpdate as TelegramDurableIngressHandler;
}

const authorizeTelegramVoice = createTelegramVoiceAuthorizer(telegramRepository);

export const handleTelegramDurableIngress = createTelegramDurableIngress({
  acceptMedia(message, incomingUpdateId, mediaKind) {
    return telegramIngressRepository.acceptMedia({
      chatId: message.chat.id,
      chatType: message.chat.type,
      mediaKind,
      updateId: incomingUpdateId,
    });
  },
  authorizeVoice: authorizeTelegramVoice,
  botUsername: process.env.TELEGRAM_BOT_USERNAME as string,
  handleSoftwareUpdateCallback,
  leaseMilliseconds: TELEGRAM_INGRESS_LEASE_MS,
  repository: telegramIngressRepository,
  async requestSessionRotation(eveSessionId) {
    const applicationSessionId = await sessionRepository.findActiveIdByEveSessionId(eveSessionId);
    if (applicationSessionId === null) return;
    await sessionRepository.requestRotation(applicationSessionId, "session_failed");
  },
  transcribeVoice: transcribeTelegramVoice,
});
