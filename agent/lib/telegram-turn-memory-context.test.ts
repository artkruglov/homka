/**
 * Telegram turn memory context tests.
 *
 * Constructs covered:
 * - Retrieved records become delivery context, so the system prefix stays byte-stable per chat.
 * - Memory authorization derives from verified access and actor, never from message text.
 * - The same-turn profile view binds to the application session and timeline entry.
 * - Failures degrade to an explicit unavailability notice instead of failing the turn.
 */
import { describe, expect, it, vi } from "vitest";

import { MEMORY_FRESHNESS_REMINDER } from "./memory-retrieval.js";
import { createTelegramMemoryContextBuilder } from "./telegram-turn-memory-context.js";

const access = {
  familyId: "family-1",
  groupId: null,
  memoryScopes: ["personal", "family"] as Array<"family" | "group" | "personal">,
  role: "owner" as const,
  userId: "user-1",
};

function input(overrides: Partial<Parameters<ReturnType<typeof createTelegramMemoryContextBuilder>>[0]> = {}) {
  return {
    access,
    actor: { id: "101", kind: "telegram_user" as const },
    applicationSessionId: "app-session-1",
    conversationId: "conversation-1",
    explicitMentionTelegramUserIds: [],
    query: "что купить?",
    replyTelegramUserId: null,
    replyTimelineSequence: null,
    timelineEntryId: "entry-1",
    turnStartedAt: new Date("2026-08-08T10:00:00.000Z"),
    webSearchAvailable: true,
    ...overrides,
  };
}

const emptyRetrieval = { memories: [], retrievedClaimIds: [], threads: { threads: [], totalCharacters: 0 } };

describe("createTelegramMemoryContextBuilder", () => {
  it("returns retrieved records as one context block", async () => {
    const retrieve = vi.fn().mockResolvedValue({
      ...emptyRetrieval,
      memories: [{ content: "Любит гречку", memoryRef: "mem_1" }],
    });
    const build = createTelegramMemoryContextBuilder({ createProfile: vi.fn().mockResolvedValue(null), retrieve });

    const blocks = await build(input());

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("<retrieved_long_term_memory>");
    expect(blocks[0]).toContain("Любит гречку");
    expect(blocks[0]).toContain("<memory-used></memory-used>");
    expect(retrieve).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: "family-1",
        groupId: null,
        role: "owner",
        scopes: ["personal", "family"],
        telegramActorId: "101",
        telegramActorKind: "telegram_user",
        telegramUserId: "101",
        userId: "user-1",
      }),
      "что купить?",
      [],
      { excludeMemoryRefs: new Set() },
    );
  });

  // SEARCH-14F-R4, 14 сентября 2026: при записи о походе в музей бот дважды ответил без поиска.
  // Эвал stress/search-evals/freshness.ts без рассуждений, как в production: поиск при записи в
  // памяти 7/12 без напоминания и 11–12/12 с ним, открытие страницы 5/12 против 8/12.
  it("reminds right after shown records that memory does not confirm current facts when search exists", async () => {
    const retrieve = vi.fn().mockResolvedValue({
      ...emptyRetrieval,
      memories: [{ content: "Музей работает с 10 до 18", memoryRef: "mem_1" }],
    });
    const build = createTelegramMemoryContextBuilder({ createProfile: vi.fn().mockResolvedValue(null), retrieve });

    const [withSearch] = await build(input());
    expect(withSearch!.endsWith(MEMORY_FRESHNESS_REMINDER)).toBe(true);

    const [withoutSearch] = await build(input({ webSearchAvailable: false }));
    expect(withoutSearch).not.toContain(MEMORY_FRESHNESS_REMINDER);
    expect(withoutSearch).toContain("<memory-used></memory-used>");
  });

  it("appends the pending repeat-task hint once and after the memory block", async () => {
    const takeSkillHint = vi.fn().mockResolvedValue({ kind: "repeat", stepCount: 5, toolNames: ["web_search", "generate_image"] });
    const build = createTelegramMemoryContextBuilder({
      createProfile: vi.fn().mockResolvedValue(null),
      retrieve: vi.fn().mockResolvedValue(emptyRetrieval),
      takeSkillHint,
    });

    const blocks = await build(input());

    expect(takeSkillHint).toHaveBeenCalledWith("conversation-1");
    expect(blocks).toHaveLength(2);
    // Nothing was shown, so the model is not asked to declare what it used.
    expect(blocks[0]).not.toContain("<memory-used>");
    expect(blocks[0]).not.toContain(MEMORY_FRESHNESS_REMINDER);
    expect(blocks[1]).toContain("5 шагов инструментов: web_search, generate_image");
    expect(blocks[1]).toContain("предложи сохранить её как навык");
  });

  it("keeps recently shown records out of retrieval, hides a repeated author card and records exposures", async () => {
    const exposures = {
      authorCardShownRecently: vi.fn().mockResolvedValue(true),
      recentlyShownMemoryRefs: vi.fn().mockResolvedValue(new Set(["mem_seen"])),
      record: vi.fn().mockResolvedValue(undefined),
      sessionTurn: vi.fn().mockResolvedValue(12),
    };
    const retrieve = vi.fn().mockResolvedValue({
      ...emptyRetrieval,
      memories: [{ content: "Любит гречку", memoryRef: "mem_fresh" }],
    });
    const createProfile = vi.fn().mockResolvedValue({
      generatedAt: "2026-08-08T10:00:00.000Z", profileViewRef: "pv_1", totalCharacters: 10,
      subjects: [{ claims: [{ memoryRef: "mem_reply" }], label: "Женя", priority: "reply_subject", subjectRef: "s1", totalCharacters: 10 }],
    });
    const build = createTelegramMemoryContextBuilder({ createProfile, exposures, retrieve });

    await build(input({ replyTelegramUserId: "202" }));

    expect(retrieve).toHaveBeenCalledWith(expect.anything(), "что купить?", [], { excludeMemoryRefs: new Set(["mem_seen"]) });
    expect(exposures.authorCardShownRecently).toHaveBeenCalledWith("app-session-1", "101", 12);
    expect(createProfile.mock.calls[0]![1]).toMatchObject({ suppressCurrentAuthor: true });
    expect(exposures.record).toHaveBeenCalledWith({
      applicationSessionId: "app-session-1", authorTelegramUserId: null,
      memoryRefs: ["mem_fresh", "mem_reply"], sessionTurn: 12,
    });
  });

  it("shows the author card again when the author is the reply subject and records it", async () => {
    const exposures = {
      authorCardShownRecently: vi.fn().mockResolvedValue(true),
      recentlyShownMemoryRefs: vi.fn().mockResolvedValue(new Set()),
      record: vi.fn().mockResolvedValue(undefined),
      sessionTurn: vi.fn().mockResolvedValue(3),
    };
    const createProfile = vi.fn().mockResolvedValue({
      generatedAt: "2026-08-08T10:00:00.000Z", profileViewRef: "pv_2", totalCharacters: 10,
      subjects: [{ claims: [{ memoryRef: "mem_me" }], label: "Илья", priority: "current_author", subjectRef: "s2", totalCharacters: 10 }],
    });
    const build = createTelegramMemoryContextBuilder({
      createProfile, exposures, retrieve: vi.fn().mockResolvedValue(emptyRetrieval),
    });

    await build(input({ explicitMentionTelegramUserIds: ["101"] }));

    expect(exposures.authorCardShownRecently).not.toHaveBeenCalled();
    expect(createProfile.mock.calls[0]![1]).toMatchObject({ suppressCurrentAuthor: false });
    expect(exposures.record).toHaveBeenCalledWith(expect.objectContaining({ authorTelegramUserId: "101", memoryRefs: ["mem_me"] }));
  });

  it("adds nothing when the message carries no text", async () => {
    const retrieve = vi.fn();
    const build = createTelegramMemoryContextBuilder({ createProfile: vi.fn(), retrieve });

    expect(await build(input({ query: "   " }))).toEqual([]);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("binds the same-turn profile view to the application session and timeline entry", async () => {
    const retrieve = vi.fn().mockResolvedValue({ ...emptyRetrieval, retrievedClaimIds: ["claim-related"] });
    const createProfile = vi.fn().mockResolvedValue({
      generatedAt: "2026-08-08T10:00:00.000Z",
      profileViewRef: "view_11111111111111111111111111111111",
      subjects: [],
      totalCharacters: 0,
    });
    const build = createTelegramMemoryContextBuilder({ createProfile, retrieve });

    const blocks = await build(input({
      explicitMentionTelegramUserIds: ["202"],
      replyTelegramUserId: "203",
      replyTimelineSequence: "44",
    }));

    expect(createProfile).toHaveBeenCalledWith(expect.objectContaining({ familyId: "family-1" }), {
      conversationId: "conversation-1",
      currentTelegramUserId: "101",
      explicitMentionTelegramUserIds: ["202"],
      now: new Date("2026-08-08T10:00:00.000Z"),
      provenance: { sessionId: "app-session-1", turnId: "entry-1" },
      replyTelegramUserId: "203",
      replyTimelineSequence: "44",
      retrievalClaimIds: ["claim-related"],
      suppressCurrentAuthor: false,
    });
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain("<verified_profile_view");
    expect(blocks[1]).toContain("<retrieved_long_term_memory>");
  });

  it("creates no profile view for a channel actor", async () => {
    const createProfile = vi.fn();
    const build = createTelegramMemoryContextBuilder({
      createProfile,
      retrieve: vi.fn().mockResolvedValue(emptyRetrieval),
    });

    const blocks = await build(input({
      access: { ...access, groupId: "group-1", memoryScopes: ["group"], role: "external", userId: null },
      actor: { id: "-1001000000002", kind: "telegram_channel" },
    }));

    expect(createProfile).not.toHaveBeenCalled();
    expect(blocks).toHaveLength(1);
  });

  it("discloses unavailable memory instead of failing the turn when retrieval breaks", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const build = createTelegramMemoryContextBuilder({
      createProfile: vi.fn(),
      retrieve: vi.fn().mockRejectedValue(new Error("embedding service down")),
    });

    const blocks = await build(input());

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("AGENT_MEMORY_UNAVAILABLE");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("AGENT_MEMORY_UNAVAILABLE"));
    log.mockRestore();
  });
});
