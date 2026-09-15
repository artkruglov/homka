/**
 * Interactive terminal prompt adapter.
 *
 * Exports:
 * - `createTerminalPrompts`: line-oriented required text, secret, confirmation, and selection input.
 */
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import type { Readable } from "node:stream";

import type { PromptAdapter, PromptOption } from "./contracts.ts";
import { InstallerError } from "./errors.ts";

const CONFIRM_OPTIONS = new Map([
  ["да", true],
  ["нет", false],
]);

export function createTerminalPrompts(
  input: Readable & { isTTY?: boolean } = process.stdin,
  output: Writable = process.stdout,
): PromptAdapter & { close: () => void } {
  if (!input.isTTY || !(output as Writable & { isTTY?: boolean }).isTTY) {
    throw new InstallerError(
      "OSINARA_INSTALL_INTERACTIVE_TERMINAL_REQUIRED",
      "Интерактивная установка требует TTY. Запустите команду в терминале",
    );
  }
  let suppressTerminalEcho = false;
  const controlledOutput = new Writable({
    write(chunk, encoding, callback) {
      if (!suppressTerminalEcho) output.write(chunk, encoding);
      callback();
    },
  });
  Object.assign(controlledOutput, { isTTY: true });
  const readline = createInterface({ input, output: controlledOutput, terminal: true });

  // Blank input is never interpreted as a default; every decision must be explicit.
  async function requiredAnswer(message: string): Promise<string> {
    const answer = (await readline.question(`${message}: `)).trim();
    if (!answer) {
      throw new InstallerError(
        "OSINARA_INSTALL_PROMPT_VALUE_MISSING",
        `Для вопроса «${message}» требуется явный ответ`,
      );
    }
    return answer;
  }

  return {
    close: () => readline.close(),
    confirm: async (message) => {
      const answer = (await requiredAnswer(`${message} [да/нет]`)).toLowerCase();
      const decision = CONFIRM_OPTIONS.get(answer);
      if (decision === undefined) {
        throw new InstallerError(
          "OSINARA_INSTALL_PROMPT_VALUE_INVALID",
          "Для подтверждения введите только «да» или «нет»",
        );
      }
      return decision;
    },
    secret: async (message) => {
      output.write(`${message}: `);
      suppressTerminalEcho = true;
      try {
        const answer = (await readline.question("")).trim();
        if (!answer) {
          throw new InstallerError(
            "OSINARA_INSTALL_PROMPT_VALUE_MISSING",
            `Для вопроса «${message}» требуется явный ответ`,
          );
        }
        return answer;
      } finally {
        suppressTerminalEcho = false;
        output.write("\n");
      }
    },
    select: async <T extends string>(message: string, options: readonly PromptOption<T>[]) => {
      options.forEach((option, index) => output.write(`${index + 1}. ${option.label}\n`));
      const answer = await requiredAnswer(message);
      const selectedIndex = Number(answer) - 1;
      const selected = Number.isInteger(selectedIndex) ? options[selectedIndex] : undefined;
      if (!selected) {
        throw new InstallerError(
          "OSINARA_INSTALL_PROMPT_VALUE_INVALID",
          `Выберите номер от 1 до ${options.length}`,
        );
      }
      return selected.value;
    },
    text: requiredAnswer,
  };
}
