/**
 * Owner health digest tests.
 *
 * Constructs covered:
 * - The digest names every signal it has and says "no failures" otherwise, always with memory counts.
 * - Лейны приходят счётчиками и кодами: дайджест читают в личной области владельца, а стоящий
 *   лейн может принадлежать соседней, и её название было бы содержимым чужой области.
 * - Nothing is sent before the digest hour; one send per family per day through the claim.
 * - A failed delivery releases the claim and does not stop other families.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createOwnerHealthDigestDispatcher,
  digestDateFor,
  formatOwnerHealthDigest,
} from "./owner-health-digest.js";
import type { OwnerHealthReport } from "./owner-health-digest-repository.js";
import { MemoryReviewOwnerAlertTransportError } from "../memory-review/memory-review-owner-alert-transport.js";

const quiet: OwnerHealthReport = {
  alertDeliveryFailures: 0,
  ingressFailures: { codes: [], count: 0 },
  lanes: {
    blocked: { codes: [], count: 0, waiting: 0 },
    lagging: { count: 0, oldestAt: null, waiting: 0 },
  },
  memoryWritten: [{ count: 3, kind: "episode", scope: "group" }, { count: 1, kind: "profile", scope: "personal" }],
  modelSpend: { cacheHitTokens: 0, cacheMissTokens: 0, calls: 0, costUsd: 0, outputTokens: 0, unpricedCalls: 0, webSearchCalls: 0 },
  proactiveFailures: { reminders: 0, schedules: 0 },
  reviewBatches: { ambiguous: 0, failed: 0 },
  rotations: { count: 0, latestAt: null },
  storage: { databaseBytes: 1024 ** 3, freeBytes: 80 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 },
  windowStart: new Date("2026-09-08T06:00:00.000Z"),
};

describe("formatOwnerHealthDigest", () => {
  it("does not report a healthy day when reminder or schedule delivery needs attention", () => {
    const text = formatOwnerHealthDigest({
      ...quiet,
      proactiveFailures: { reminders: 2, schedules: 1 },
    });
    expect(text).not.toContain("сбоев нет");
    expect(text).toContain("Требуют проверки: напоминания — 2, расписания — 1.");
    expect(text).toContain("Перед возобновлением проверьте, не пришло ли сообщение");
  });

  it("names a disk that no longer fits a rollback, and stays quiet about a roomy one", () => {
    const gib = 1024 ** 3;
    expect(formatOwnerHealthDigest(quiet)).not.toContain("Диск:");
    const text = formatOwnerHealthDigest({
      ...quiet,
      storage: { databaseBytes: 30 * gib, freeBytes: 50 * gib, totalBytes: 100 * gib },
    });
    expect(text).toContain("Две копии дампа уже не помещаются");
    expect(text).not.toContain("сбоев нет");
  });

  it("reports a quiet day with the memory counts", () => {
    expect(formatOwnerHealthDigest(quiet)).toBe(
      "Сводка за сутки: сбоев нет.\nПамять: +4 (group episode 3, personal profile 1).",
    );
  });

  // 14 сентября 2026 баланс DeepSeek ушёл в минус, и бот потерял модель раньше, чем кто-то это
  // заметил. Расход в долларах и баланс видны каждое утро; предупреждением становится только
  // низкий или заблокированный баланс.
  it("adds the day's model spend and the balance, and warns only about a low balance", () => {
    const spent = {
      ...quiet,
      memoryWritten: [],
      modelSpend: { cacheHitTokens: 1_680_000, cacheMissTokens: 320_000, calls: 24, costUsd: 0.11, outputTokens: 12_000, unpricedCalls: 0, webSearchCalls: 5 },
    };
    expect(formatOwnerHealthDigest(spent, { available: true, totalUsd: 4.2 })).toBe([
      "Сводка за сутки: сбоев нет.",
      "Модель за сутки: 0,11 $, 24 вызова, вход мимо кэша 320 тыс., из кэша 84 %, выход 12 тыс., поисков 5.",
      "DeepSeek: баланс 4,20 $.",
      "Память: новых записей нет.",
    ].join("\n"));
    const blocked = formatOwnerHealthDigest(spent, { available: false, totalUsd: -0.04 });
    expect(blocked.startsWith("Сводка за сутки.\nDeepSeek: запросы недоступны, баланс −0,04 $.")).toBe(true);
  });

  it("names rotations, ingress failures, stuck lanes and undelivered alerts", () => {
    const text = formatOwnerHealthDigest({
      ...quiet,
      alertDeliveryFailures: 1,
      ingressFailures: { codes: [{ code: "AGENT_TELEGRAM_DISPATCH_FAILED", count: 2 }], count: 2 },
      lanes: {
        blocked: { codes: [{ code: "failed/MODEL_CALL_FAILED", count: 1 }], count: 1, waiting: 1400 },
        lagging: { count: 2, oldestAt: new Date("2026-09-08T20:15:00.000Z"), waiting: 80 },
      },
      memoryWritten: [],
      reviewBatches: { ambiguous: 1, failed: 2 },
      rotations: { count: 1, latestAt: new Date("2026-09-08T18:41:00.000Z") },
    });
    expect(text).toBe([
      "Сводка за сутки.",
      "Сессии: 1 ротаций после сбоя, последняя 8 сентября в 21:41.",
      "Очередь Telegram: 2 сбоев (AGENT_TELEGRAM_DISPATCH_FAILED ×2).",
      "Проверка памяти: 1 лейнов стоят (failed/MODEL_CALL_FAILED ×1), ждут 1400 сообщений.",
      "Проверка памяти: 2 лейнов отстают, ждут 80 сообщений с 8 сентября в 23:15.",
      "Пакеты проверки: failed 2, ambiguous 1.",
      "Не доставлено предупреждений владельцу: 1.",
      "Память: новых записей нет.",
    ].join("\n"));
  });
});

describe("digestDateFor", () => {
  it("is empty before the digest hour and the UTC date after it", () => {
    expect(digestDateFor(new Date("2026-09-09T05:59:00.000Z"))).toBeNull();
    expect(digestDateFor(new Date("2026-09-09T06:00:00.000Z"))).toBe("2026-09-09");
    expect(digestDateFor(new Date("2026-09-09T23:30:00.000Z"))).toBe("2026-09-09");
  });
});

describe("createOwnerHealthDigestDispatcher", () => {
  afterEach(() => vi.restoreAllMocks());

  function dependencies(overrides: Partial<Parameters<typeof createOwnerHealthDigestDispatcher>[0]> = {}) {
    return {
      abandon: vi.fn().mockResolvedValue(undefined),
      claim: vi.fn().mockResolvedValue(true),
      complete: vi.fn().mockResolvedValue(undefined),
      deliver: vi.fn().mockResolvedValue(undefined),
      recipients: vi.fn().mockResolvedValue([
        { familyId: "family-1", ownerTelegramUserId: "101", quietEnd: null, quietStart: null, timezone: "UTC" },
        { familyId: "family-2", ownerTelegramUserId: "202", quietEnd: null, quietStart: null, timezone: "UTC" },
      ]),
      release: vi.fn().mockResolvedValue(undefined),
      report: vi.fn().mockResolvedValue(quiet),
      balance: vi.fn().mockResolvedValue(null),
      ...overrides,
    };
  }

  it("waits out the quiet hours of its reader instead of taking the claim", async () => {
    // Заявка не берётся вовсе: взять её и не отправить значит потерять дайджест за день, а
    // тихие часы кончатся до конца этих суток, и следующий тик разбудит его сам.
    const deps = dependencies({
      recipients: vi.fn().mockResolvedValue([
        { familyId: "family-1", ownerTelegramUserId: "101", quietEnd: "08:00", quietStart: "22:00", timezone: "Asia/Vladivostok" },
      ]),
    });
    await expect(createOwnerHealthDigestDispatcher(deps)(new Date("2026-09-09T13:00:00.000Z"))).resolves.toBe(0);
    expect(deps.claim).not.toHaveBeenCalled();
    expect(deps.deliver).not.toHaveBeenCalled();
  });

  it("sends the same digest once the quiet hours are over", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const deps = dependencies({
      recipients: vi.fn().mockResolvedValue([
        { familyId: "family-1", ownerTelegramUserId: "101", quietEnd: "08:00", quietStart: "22:00", timezone: "Asia/Vladivostok" },
      ]),
    });
    await expect(createOwnerHealthDigestDispatcher(deps)(new Date("2026-09-09T13:00:00.000Z"))).resolves.toBe(0);
    await expect(createOwnerHealthDigestDispatcher(deps)(new Date("2026-09-09T22:30:00.000Z"))).resolves.toBe(1);
    expect(deps.deliver).toHaveBeenCalledTimes(1);
  });

  it("does not send a second copy after an ambiguous delivery", async () => {
    // Telegram мог сообщение принять, а ответ потеряться. Повтор здесь стоил бы владельцу второй
    // сводки за те же сутки, поэтому неясный исход записывается и остаётся терминальным.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps = dependencies({
      deliver: vi.fn().mockRejectedValue(new Error("socket hang up")),
    });
    await createOwnerHealthDigestDispatcher(deps)(new Date("2026-09-09T06:10:00.000Z"));
    expect(deps.release).not.toHaveBeenCalled();
    expect(deps.abandon).toHaveBeenCalledWith("family-1", "2026-09-09",
      "AGENT_OWNER_HEALTH_DIGEST_AMBIGUOUS");
  });

  it("lets a refused delivery be retried, because nothing was sent", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps = dependencies({
      deliver: vi.fn().mockRejectedValue(
        new MemoryReviewOwnerAlertTransportError("failed", "AGENT_TELEGRAM_DELIVERY_REJECTED", "403"),
      ),
    });
    await createOwnerHealthDigestDispatcher(deps)(new Date("2026-09-09T06:10:00.000Z"));
    expect(deps.release).toHaveBeenCalledWith("family-1", "2026-09-09");
    expect(deps.abandon).not.toHaveBeenCalled();
  });

  it("sends nothing before the digest hour", async () => {
    const deps = dependencies();
    await expect(createOwnerHealthDigestDispatcher(deps)(new Date("2026-09-09T05:00:00.000Z"))).resolves.toBe(0);
    expect(deps.recipients).not.toHaveBeenCalled();
  });

  it("sends one digest per family and completes the claim with the text length", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const deps = dependencies({ claim: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false) });
    const now = new Date("2026-09-09T06:10:00.000Z");

    await expect(createOwnerHealthDigestDispatcher(deps)(now)).resolves.toBe(1);

    expect(deps.report).toHaveBeenCalledWith("family-1", new Date("2026-09-08T06:10:00.000Z"), now);
    expect(deps.deliver).toHaveBeenCalledTimes(1);
    expect(deps.deliver).toHaveBeenCalledWith({ chatId: "101", text: formatOwnerHealthDigest(quiet) });
    expect(deps.balance).toHaveBeenCalledTimes(1);
    expect(deps.complete).toHaveBeenCalledWith("family-1", "2026-09-09", now, formatOwnerHealthDigest(quiet).length);
    expect(deps.release).not.toHaveBeenCalled();
  });

  it("releases the claim when Telegram refuses and goes on to the next family", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps = dependencies({
      deliver: vi.fn().mockRejectedValueOnce(
        new MemoryReviewOwnerAlertTransportError("failed", "AGENT_TELEGRAM_DELIVERY_REJECTED", "403"),
      ).mockResolvedValueOnce(undefined),
    });

    await expect(createOwnerHealthDigestDispatcher(deps)(new Date("2026-09-09T07:00:00.000Z"))).resolves.toBe(1);

    expect(deps.release).toHaveBeenCalledWith("family-1", "2026-09-09");
    expect(deps.complete).toHaveBeenCalledTimes(1);
    expect(deps.complete).toHaveBeenCalledWith("family-2", "2026-09-09", expect.any(Date), expect.any(Number));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("AGENT_OWNER_HEALTH_DIGEST_FAILED"));
  });
});
