/**
 * Operational CLI command tests.
 *
 * Constructs covered:
 * - `createOperationalCommands`: status, doctor, logs, restart, and owner-bootstrap contracts.
 * - Exact argument validation and fail-fast host prerequisite ordering.
 */
import { describe, expect, it, vi } from "vitest";

import { createOperationalCommands } from "./operational-commands.js";

function operations() {
  return {
    assertHostPrerequisites: vi.fn().mockResolvedValue(undefined),
    doctor: vi.fn(),
    logs: vi.fn(),
    ownerBootstrap: vi.fn(),
    restart: vi.fn(),
    status: vi.fn(),
  };
}

describe("createOperationalCommands", () => {
  it("returns secret-free status", async () => {
    const ops = operations();
    ops.status.mockResolvedValue({
        address: "https://bot.example.com",
        healthy: true,
        model: "deepseek-reasoner",
        provider: "deepseek",
        version: "0.15.3",
    });
    const commands = createOperationalCommands(ops);

    await expect(commands.status([])).resolves.toMatchObject({ healthy: true, version: "0.15.3" });
  });

  it("requires an explicit bounded line count for logs", async () => {
    const ops = operations();
    const commands = createOperationalCommands(ops);

    await expect(commands.logs([])).rejects.toMatchObject({ code: "OSINARA_CLI_ARGUMENT_INVALID" });
    await expect(commands.logs(["201"])).rejects.toMatchObject({ code: "OSINARA_CLI_ARGUMENT_INVALID" });
    await commands.logs(["100"]);
    expect(ops.logs).toHaveBeenCalledWith(100);
  });

  it("rejects unexpected arguments before an operational side effect", async () => {
    const ops = operations();
    const commands = createOperationalCommands(ops);

    await expect(commands.restart(["--force"])).rejects.toMatchObject({
      code: "OSINARA_CLI_ARGUMENT_INVALID",
    });
    expect(ops.restart).not.toHaveBeenCalled();
  });

  it.each([
    ["doctor", []],
    ["logs", ["20"]],
    ["owner-bootstrap", []],
    ["restart", []],
    ["status", []],
  ] as const)("checks root/Linux before running %s", async (command, args) => {
    const ops = operations();
    ops.assertHostPrerequisites.mockRejectedValue(new Error("not root Linux"));
    const commands = createOperationalCommands(ops);

    await expect(commands[command](args)).rejects.toThrow("not root Linux");

    const operationName = command === "owner-bootstrap" ? "ownerBootstrap" : command;
    expect(ops[operationName]).not.toHaveBeenCalled();
  });
});
