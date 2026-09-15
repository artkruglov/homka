/**
 * Osinara CLI routing tests.
 *
 * Constructs covered:
 * - `runCli`: routes every declared command through an explicit adapter.
 * - Unavailable operational adapters and unknown commands return stable non-success codes.
 */
import { describe, expect, it, vi } from "vitest";

import { runCli } from "./cli.js";
import { InstallerError } from "./errors.js";

describe("osinara CLI routing", () => {
  it.each(["install", "status", "config", "doctor", "logs", "restart", "owner-bootstrap"] as const)(
    "routes %s to its injected command adapter",
    async (command) => {
      const writeError = vi.fn();
      const writeOutput = vi.fn();
      const operation = vi.fn().mockResolvedValue({ code: "TEST_OK", message: command });

      await expect(
        runCli([command], {
          operations: { [command]: operation },
          writeError,
          writeOutput,
        }),
      ).resolves.toBe(0);
      expect(operation).toHaveBeenCalledWith([]);
      expect(writeOutput).toHaveBeenCalledWith(JSON.stringify({ code: "TEST_OK", message: command }));
    },
  );

  it("does not claim success when an operational adapter is unavailable", async () => {
    const writeError = vi.fn();

    await expect(
      runCli(["status"], { operations: {}, writeError, writeOutput: vi.fn() }),
    ).resolves.toBe(1);
    expect(writeError).toHaveBeenCalledWith(
      expect.stringContaining("OSINARA_CLI_OPERATION_UNAVAILABLE"),
    );
  });

  it("preserves a stable installer error code at the CLI boundary", async () => {
    const writeError = vi.fn();

    await expect(
      runCli(["install"], {
        operations: {
          install: vi.fn().mockRejectedValue(
            new InstallerError(
              "OSINARA_INSTALL_RELEASE_ASSETS_UNAVAILABLE",
              "Для установки отсутствуют release assets",
            ),
          ),
        },
        writeError,
        writeOutput: vi.fn(),
      }),
    ).resolves.toBe(1);
    expect(writeError).toHaveBeenCalledWith(
      "OSINARA_INSTALL_RELEASE_ASSETS_UNAVAILABLE: Для установки отсутствуют release assets",
    );
  });

  it("prints usage for help and rejects unknown commands", async () => {
    const writeOutput = vi.fn();
    await expect(
      runCli(["help"], { operations: {}, writeError: vi.fn(), writeOutput }),
    ).resolves.toBe(0);
    expect(writeOutput).toHaveBeenCalledWith(expect.stringContaining("osinara install"));

    const writeError = vi.fn();
    await expect(
      runCli(["destroy"], { operations: {}, writeError, writeOutput: vi.fn() }),
    ).resolves.toBe(2);
    expect(writeError).toHaveBeenCalledWith(expect.stringContaining("OSINARA_CLI_COMMAND_INVALID"));
  });
});
