/**
 * Telegram model-message delivery policy tests.
 *
 * Constructs covered:
 * - `completedTelegramOutput`: separates visible text from terminal reaction directives.
 * - Pre-tool assistant chunks remain hidden because Telegram cannot render them ephemerally.
 * - Empty model steps remain invisible to avoid technical Telegram noise.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { completedTelegramOutput } from "./telegram-progress.js";

describe("completedTelegramOutput", () => {
  afterEach(() => vi.restoreAllMocks());

  it("delivers model-authored pre-tool text as an interim progress notice", () => {
    expect(
      completedTelegramOutput({
        finishReason: "tool-calls",
        message: "Собрал информацию. Теперь формирую документ.",
      }),
    ).toEqual({ kind: "progress", message: "Собрал информацию. Теперь формирую документ." });
  });

  it("drops interim text that carries a reaction directive", () => {
    expect(
      completedTelegramOutput({
        finishReason: "tool-calls",
        message: "<telegram-reaction>👍</telegram-reaction>",
      }),
    ).toBeNull();
  });

  it("delivers nothing for the silence directive, even wrapped in whitespace or prose remnants", () => {
    // The model cannot return a truly empty answer: Eve retries an empty step once and the retry
    // comes back as a placeholder such as "(пусто)". The directive is the explicit way to be quiet.
    expect(completedTelegramOutput({ finishReason: "stop", message: "<telegram-silent>" })).toBeNull();
    expect(completedTelegramOutput({ finishReason: "stop", message: "\n <telegram-silent> \n" })).toBeNull();
    expect(completedTelegramOutput({
      finishReason: "stop",
      message: "<telegram-silent>\n<memory-used>mem_0123456789abcdef0123456789abcdef</memory-used>",
    })).toBeNull();
    // A directive next to visible text is a model mistake: the text wins, the directive vanishes.
    expect(completedTelegramOutput({ finishReason: "stop", message: "Ладно, молчу. <telegram-silent>" }))
      .toEqual({ kind: "message", memoryUsedDeclared: false, memoryUsedRefs: [], message: "Ладно, молчу." });
    expect(completedTelegramOutput({ finishReason: "tool-calls", message: "<telegram-silent>" })).toBeNull();
  });

  it("does not deliver an answer made of transport directives alone", () => {
    expect(completedTelegramOutput({ finishReason: "stop", message: "<telegram-split>" }))
      .toBeNull();
  });

  it("separates the memory-used directive from the delivered final answer", () => {
    expect(completedTelegramOutput({
      finishReason: "stop",
      message: "Гоша дома.\n<memory-used>mem_0123456789abcdef0123456789abcdef</memory-used>",
    })).toEqual({
      kind: "message",
      memoryUsedDeclared: true,
      memoryUsedRefs: ["mem_0123456789abcdef0123456789abcdef"],
      message: "Гоша дома.",
    });
    expect(completedTelegramOutput({
      finishReason: "stop",
      message: "<memory-used>mem_0123456789abcdef0123456789abcdef</memory-used>",
    })).toBeNull();
  });

  it("strips leaked tool-call markup from a delivered answer and logs it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const leaked = "Принято.\n<｜DSML｜calls>\n<｜DSML｜invoke name=\"remember\">\n<｜DSML｜parameter name=\"kind\">profile</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜calls>";
    // A model that writes a tool call as text must not reach the chat with it.
    expect(completedTelegramOutput({ finishReason: "stop", message: leaked }))
      .toEqual({ kind: "message", memoryUsedDeclared: false, memoryUsedRefs: [], message: "Принято." });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("AGENT_MODEL_TOOL_MARKUP_LEAKED"));
    expect(completedTelegramOutput({ finishReason: "stop", message: "<｜DSML｜calls>\n<｜DSML｜invoke name=\"remember\"></｜DSML｜invoke>\n</｜DSML｜calls>" })).toBeNull();
    warn.mockRestore();
  });

  it("logs an answer that is the memory-used directive alone", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(completedTelegramOutput({ finishReason: "stop", message: "<memory-used></memory-used>" })).toBeNull();
    expect(warn).toHaveBeenCalledWith(JSON.stringify({ code: "AGENT_MEMORY_USED_DIRECTIVE_ONLY" }));
    warn.mockClear();
    expect(completedTelegramOutput({
      finishReason: "stop",
      message: "<telegram-silent>\n<memory-used></memory-used>",
    })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps aside directives inside a final answer for the presentation layer", () => {
    expect(
      completedTelegramOutput({ finishReason: "stop", message: "Готово\n<telegram-split>\nкстати" }),
    ).toEqual({ kind: "message", memoryUsedDeclared: false, memoryUsedRefs: [], message: "Готово\n<telegram-split>\nкстати" });
  });

  it("trims surrounding whitespace from a delivered message", () => {
    expect(
      completedTelegramOutput({ finishReason: "stop", message: "\n\nГотовый ответ  " }),
    ).toEqual({ kind: "message", memoryUsedDeclared: false, memoryUsedRefs: [], message: "Готовый ответ" });
  });

  it.each(["👍", "❤", "🔥", "🥰", "🤔", "🤯", "🫡", "👀", "🖕"])(
    "parses one %s emoji reaction without visible text",
    (emoji) => {
      expect(
        completedTelegramOutput({
          finishReason: "stop",
          message: `\n<telegram-reaction>${emoji}</telegram-reaction>\n`,
        }),
      ).toEqual({ emoji, kind: "reaction" });
    },
  );

  it("canonicalizes a reaction written with a variation selector", () => {
    expect(
      completedTelegramOutput({ finishReason: "stop", message: "<telegram-reaction>❤️</telegram-reaction>" }),
    ).toEqual({ emoji: "❤", kind: "reaction" });
  });

  // An emoji outside Telegram's reaction set would be refused with 400 and leave the person with
  // nothing; the gesture becomes the closest reaction Telegram accepts.
  it.each([["😸", "🥰"], ["1️⃣", "👍"], ["🇺🇸", "👍"], ["😂", "🤣"]])(
    "replaces a non-reaction emoji %s with the closest allowed reaction %s",
    (emoji, expected) => {
      expect(
        completedTelegramOutput({
          finishReason: "stop",
          message: `<telegram-reaction>${emoji}</telegram-reaction>`,
        }),
      ).toEqual({ emoji: expected, kind: "reaction" });
    },
  );

  it.each([
    "<telegram-reaction>не emoji</telegram-reaction>",
    "<telegram-reaction>🔥🔥</telegram-reaction>",
    "<telegram-reaction>🇦</telegram-reaction>",
    "Хорошо <telegram-reaction>👌</telegram-reaction>",
    "<telegram-reaction>👍</telegram-reaction> Молчу",
    "<telegram-reaction></telegram-reaction>",
  ])("rejects malformed or mixed reaction output: %s", (message) => {
    expect(() => completedTelegramOutput({ finishReason: "stop", message }))
      .toThrowError(/AGENT_TELEGRAM_REACTION_DIRECTIVE_INVALID/u);
  });

  it.each([
    { finishReason: "tool-calls", message: "   " },
    { finishReason: "stop", message: "" },
    { finishReason: "stop", message: null },
    { finishReason: "stop" },
  ])("does not expose an empty technical step %#", (data) => {
    expect(completedTelegramOutput(data)).toBeNull();
  });
});
