/**
 * Scheduled external-group history chunking tests.
 *
 * Constructs covered:
 * - Every retained entry remains in chronological order across bounded model chunks.
 * - Oversized message content is split into explicit parts without truncation.
 * - Escaped model serialization stays bounded without splitting Unicode surrogate pairs.
 * - Snapshot entry limits fail closed instead of returning a partial week.
 */
import { describe, expect, it } from "vitest";

import {
  chunkScheduledGroupHistory,
  serializeScheduledGroupHistoryChunk,
  type ScheduledGroupHistoryEntry,
} from "./scheduled-group-history-chunker.js";

const MODEL_CHUNK_MAX_CHARACTERS = 9_000;

function entry(sequence: number, content = `Сообщение ${sequence}`): ScheduledGroupHistoryEntry {
  return {
    actor: "user",
    content,
    displayName: "Участник",
    kind: "text",
    replyToSequence: null,
    sentAt: "2026-08-09T10:00:00.000Z",
    sequence: String(sequence),
    username: "member",
  };
}

describe("scheduled group history chunker", () => {
  it("preserves chronology across entry-bounded chunks", () => {
    const chunks = chunkScheduledGroupHistory(
      Array.from({ length: 51 }, (_, index) => entry(index + 1)),
    );

    expect(chunks).toHaveLength(2);
    expect(chunks.flat().map((item) => item.sequence)).toEqual(
      Array.from({ length: 51 }, (_, index) => String(index + 1)),
    );
  });

  it("splits one oversized message without dropping content", () => {
    const content = "я".repeat(20_000);
    const chunks = chunkScheduledGroupHistory([entry(1, content)]);
    const parts = chunks.flat();

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((item) => item.content).join("")).toBe(content);
    expect(parts.map((item) => item.contentPart)).toEqual(
      parts.map((_item, index) => ({ index: index + 1, total: parts.length })),
    );
  });

  it("bounds exact escaped model serialization and preserves Unicode content losslessly", () => {
    const content = `${"\\\"<&\u0000".repeat(2_000)}${"😀".repeat(5_000)}`;
    const chunks = chunkScheduledGroupHistory([entry(1, content)]);
    const parts = chunks.flat();

    expect(parts.map((item) => item.content).join("")).toBe(content);
    for (const chunk of chunks) {
      expect(serializeScheduledGroupHistoryChunk(chunk).length)
        .toBeLessThanOrEqual(MODEL_CHUNK_MAX_CHARACTERS);
    }
    for (const part of parts) {
      const value = part.content!;
      const first = value.charCodeAt(0);
      const last = value.charCodeAt(value.length - 1);
      expect(first >= 0xDC00 && first <= 0xDFFF).toBe(false);
      expect(last >= 0xD800 && last <= 0xDBFF).toBe(false);
    }
  });

  it("rejects more entries than the retained snapshot contract permits", () => {
    expect(() => chunkScheduledGroupHistory(
      Array.from({ length: 1_001 }, (_, index) => entry(index + 1)),
    )).toThrowError(/AGENT_SCHEDULE_HISTORY_SNAPSHOT_TOO_LARGE/u);
  });
});
