/**
 * Memory embedding chunker tests.
 *
 * Constructs covered:
 * - `chunkMemoryContent`: deterministic overlapping coverage within the E5 input budget.
 */
import { describe, expect, it } from "vitest";

import {
  MEMORY_EMBEDDING_CHUNK_MAX_CHARACTERS,
  MEMORY_EMBEDDING_CHUNK_OVERLAP_CHARACTERS,
} from "./memory-config.js";
import { chunkMemoryContent, chunkMemoryQuery } from "./memory-embedding-chunks.js";

describe("chunkMemoryContent", () => {
  it("keeps short content in one source-aligned chunk", () => {
    expect(chunkMemoryContent("  Семья любит поездки в Казань.  ")).toEqual([
      {
        chunkIndex: 0,
        content: "Семья любит поездки в Казань.",
        endOffset: 31,
        startOffset: 2,
      },
    ]);
  });

  it("covers long Russian content with bounded deterministic overlap", () => {
    const content = Array.from(
      { length: 80 },
      (_, index) => `Факт-${index} относится к семейной истории.`,
    ).join(" ");
    const chunks = chunkMemoryContent(content);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(
      chunks.map((_, index) => index),
    );
    expect(chunks.every((chunk) => chunk.content.length <= MEMORY_EMBEDDING_CHUNK_MAX_CHARACTERS)).toBe(true);
    expect(chunks.at(-1)?.endOffset).toBe(content.length);
    for (let index = 1; index < chunks.length; index += 1) {
      const previous = chunks[index - 1]!;
      const current = chunks[index]!;
      expect(previous.endOffset - current.startOffset).toBeGreaterThan(0);
      expect(previous.endOffset - current.startOffset).toBeLessThanOrEqual(
        MEMORY_EMBEDDING_CHUNK_OVERLAP_CHARACTERS,
      );
    }
  });

  it.each([
    ["memory", chunkMemoryContent], ["query", chunkMemoryQuery],
  ] as const)("keeps complete Unicode characters at every boundary in %s", (_name, chunk) => {
    // Both the hard end (400) and overlap start (320) can land inside a UTF-16 surrogate pair.
    for (const prefix of [0, 1, 79, 80, 319, 320, 399, 400]) {
      const content = "а".repeat(prefix) + "😀🧑🏽‍💻".repeat(75) + "б".repeat(500);
      const chunks = chunk(content);
      let coveredThrough = 0;
      for (const [index, current] of chunks.entries()) {
        expect(current.content).not.toMatch(/[\uD800-\uDFFF]/u);
        expect(current.content).toBe(content.slice(current.startOffset, current.endOffset));
        expect(current.content.length).toBeLessThanOrEqual(MEMORY_EMBEDDING_CHUNK_MAX_CHARACTERS);
        expect(current.chunkIndex).toBe(index);
        expect(current.startOffset).toBeLessThanOrEqual(coveredThrough);
        if (index > 0) {
          const previous = chunks[index - 1]!;
          expect(current.startOffset).toBeGreaterThan(previous.startOffset);
          expect(previous.endOffset - current.startOffset).toBeLessThanOrEqual(MEMORY_EMBEDDING_CHUNK_OVERLAP_CHARACTERS);
        }
        coveredThrough = current.endOffset;
      }
      expect(coveredThrough).toBe(content.length);
      expect(chunk(content)).toEqual(chunks);
    }
  });
});
