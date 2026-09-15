/**
 * Interactive terminal prompt tests.
 *
 * Constructs covered:
 * - `createTerminalPrompts`: refuses non-interactive streams and suppresses secret echo.
 */
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { createTerminalPrompts } from "./terminal-prompts.js";

describe("provider installer terminal prompts", () => {
  it("fails instead of reading credentials from a non-interactive pipe", () => {
    expect(() => createTerminalPrompts(new PassThrough(), new PassThrough())).toThrowError(
      /OSINARA_INSTALL_INTERACTIVE_TERMINAL_REQUIRED/,
    );
  });

  it("does not echo a secret answer to terminal output", async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = Object.assign(new PassThrough(), { isTTY: true });
    let rendered = "";
    output.on("data", (chunk) => {
      rendered += chunk.toString();
    });
    const prompts = createTerminalPrompts(input, output);

    const answer = prompts.secret("Введите секрет");
    input.write("top-secret-value\n");

    await expect(answer).resolves.toBe("top-secret-value");
    expect(rendered).toContain("Введите секрет: ");
    expect(rendered).not.toContain("top-secret-value");
    prompts.close();
  });
});
