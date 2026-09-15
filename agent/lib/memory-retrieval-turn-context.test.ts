/**
 * Automatic memory block admission tests.
 *
 * Constructs covered:
 * - A faded record (retention below the automatic threshold) stays out of the turn block.
 * - Explicit search still returns it and records the shown refs for this turn.
 * - The turn limit applies after the retention and exposure filters, so records ranked below an
 *   excluded top still reach the block, and the block never exceeds the limit.
 */
import { describe, expect, it, vi } from "vitest";

import { MEMORY_TURN_RETRIEVAL_LIMIT } from "./memory-config.js";

import type { MemoryAuthorization } from "./memory-context.js";
import type { ReferencedMemoryItem } from "./memory-record.js";
import type { ScoredMemoryRetrievalResult } from "./memory-retrieval-ranking.js";

vi.mock("./memory-embedding-client.js", () => ({
  embedMemoryQuery: vi.fn().mockResolvedValue([0.1, 0.2]),
}));
vi.mock("./memory-thread-brief-repository.js", () => ({
  memoryThreadBriefRepository: {
    activate: vi.fn().mockResolvedValue({ threads: [], totalCharacters: 0 }),
  },
}));
vi.mock("./memory-context-exposure-repository.js", () => ({
  memoryContextExposureRepository: { record: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("./memory-retrieval-repository.js", () => ({
  memoryRetrievalRepository: { searchWithConflictClosure: vi.fn() },
}));

const auth: MemoryAuthorization = {
  familyId: "family-1",
  groupId: null,
  role: "owner",
  scopes: ["personal", "family"],
  telegramActorId: "101",
  telegramActorKind: "telegram_user",
  telegramUserId: "101",
  userId: "user-1",
};

function scored(memoryRef: string, retention: number): ScoredMemoryRetrievalResult {
  const memory: ReferencedMemoryItem = {
    author: { status: "current_member", telegramUserId: "101", userId: "user-1" },
    confirmation: "model_high",
    content: `Запись ${memoryRef}`,
    createdAt: "2026-07-01T10:00:00.000Z",
    embeddingStatus: "indexed",
    id: `internal-${memoryRef}`,
    kind: "episode",
    memoryRef,
    messageThreadId: null,
    occurredAt: null,
    scope: "personal",
    sensitivity: "normal",
    source: "test:retention",
    updatedAt: "2026-07-01T10:00:00.000Z",
  };
  return {
    evidence: { russianMorphologyRank: null, semanticSimilarity: 0.9, simpleLexicalRank: null },
    exactDuplicateIdentity: memoryRef,
    memory,
    retention,
    score: 0.02,
  };
}

describe("automatic memory block admission", () => {
  it("keeps faded records out of the automatic block but not out of explicit search", async () => {
    const { memoryRetrievalRepository } = await import("./memory-retrieval-repository.js");
    const { memoryContextExposureRepository } = await import("./memory-context-exposure-repository.js");
    const { retrieveMemoryTurnContext, retrieveRelevantMemories } = await import("./memory-retrieval.js");
    vi.mocked(memoryRetrievalRepository.searchWithConflictClosure).mockResolvedValue({
      conflicts: [],
      relatedClaimIds: [],
      results: [scored("mem_fresh", 0.9), scored("mem_faded", 0.1)],
    });

    const turn = await retrieveMemoryTurnContext(auth, "марафон", []);
    expect(turn.memories.map((memory) => ("memoryRef" in memory ? memory.memoryRef : null)))
      .toEqual(["mem_fresh"]);

    const explicit = await retrieveRelevantMemories(auth, "марафон", {
      applicationSessionId: "session-1",
      sessionTurn: 7,
    });
    expect(explicit).toHaveLength(2);
    expect(memoryContextExposureRepository.record).toHaveBeenCalledWith({
      applicationSessionId: "session-1",
      authorTelegramUserId: null,
      memoryRefs: ["mem_fresh", "mem_faded"],
      sessionTurn: 7,
    });
  });

  it("fills the block from below an excluded top and caps it at the turn limit", async () => {
    const { memoryRetrievalRepository } = await import("./memory-retrieval-repository.js");
    const { retrieveMemoryTurnContext } = await import("./memory-retrieval.js");
    const shownBefore = Array.from({ length: MEMORY_TURN_RETRIEVAL_LIMIT }, (_, index) => `mem_seen${index}`);
    const fresh = Array.from({ length: MEMORY_TURN_RETRIEVAL_LIMIT + 2 }, (_, index) => `mem_fresh${index}`);
    vi.mocked(memoryRetrievalRepository.searchWithConflictClosure).mockResolvedValue({
      conflicts: [],
      relatedClaimIds: [],
      results: [...shownBefore, ...fresh].map((ref) => scored(ref, 1)),
    });

    const context = await retrieveMemoryTurnContext(auth, "что нового", [], {
      excludeMemoryRefs: new Set(shownBefore),
    });

    const refs = context.memories.flatMap((memory) => "memoryRef" in memory ? [memory.memoryRef] : []);
    expect(refs).toEqual(fresh.slice(0, MEMORY_TURN_RETRIEVAL_LIMIT));
    // The repository must be asked for more than the block holds, or the filters starve it.
    const requested = vi.mocked(memoryRetrievalRepository.searchWithConflictClosure).mock.calls.at(-1)?.[3];
    expect(requested).toBeGreaterThan(MEMORY_TURN_RETRIEVAL_LIMIT);
  });

  it("passes the event date window of an explicit search to the repository", async () => {
    const { memoryRetrievalRepository } = await import("./memory-retrieval-repository.js");
    const { retrieveRelevantMemories } = await import("./memory-retrieval.js");
    vi.mocked(memoryRetrievalRepository.searchWithConflictClosure).mockResolvedValue({ conflicts: [], relatedClaimIds: [], results: [] });

    await retrieveRelevantMemories(auth, "поездка", undefined, { occurredAfter: "2026-08-01", occurredBefore: "2026-08-31" });

    expect(vi.mocked(memoryRetrievalRepository.searchWithConflictClosure).mock.calls.at(-1)?.[4])
      .toEqual({ occurredAfter: "2026-08-01", occurredBefore: "2026-08-31" });
  });
});
