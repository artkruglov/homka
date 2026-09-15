/**
 * Memory-thread activation signal tests.
 *
 * Constructs covered:
 * - Authorized retrieval memberships, semantic title matches, and application-owned skill hints activate threads.
 * - External group memberships never cross the inward personal projection boundary.
 */
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import {
  applicationThreadSkillHints,
  selectMemoryThreadActivationCandidates,
} from "./memory-thread-activation.js";

describe("memory thread activation", () => {
  it.each(["retrieval", "title", "skill"])("activates from an authorized %s signal", (signal) => {
    const selected = selectMemoryThreadActivationCandidates([{
      authorized: true,
      originScope: "personal",
      retrievalHits: signal === "retrieval" ? 1 : 0,
      skillHint: signal === "skill",
      titleSimilarity: signal === "title" ? 0.9 : null,
    }]);

    expect(selected).toHaveLength(1);
  });

  it("does not activate an external thread from a claim projected inward to personal retrieval", () => {
    expect(selectMemoryThreadActivationCandidates([{
      authorized: false,
      originScope: "group",
      retrievalHits: 1,
      skillHint: false,
      titleSimilarity: 0.95,
    }])).toEqual([]);
  });

  it("derives investment hints only from application-owned reviewed skill identifiers", () => {
    const messages = [{
      content: [{
        input: { skill: "t-invest" },
        toolCallId: "call-1",
        toolName: "load_skill",
        type: "tool-call",
      }],
      role: "assistant",
    }] as unknown as ModelMessage[];

    expect(applicationThreadSkillHints(messages)).toEqual(["Инвестиции"]);
    expect(applicationThreadSkillHints([{
      content: [{ input: { skill: "unknown" }, toolCallId: "call-2", toolName: "load_skill", type: "tool-call" }],
      role: "assistant",
    }] as unknown as ModelMessage[])).toEqual([]);
  });
});
