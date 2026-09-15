/**
 * Stable operational CLI command adapters.
 *
 * Exports:
 * - `OperationalCommandOperations`: host guard plus status, doctor, logs, restart, and bootstrap actions.
 * - `createOperationalCommands`: validates arguments and host identity before exact actions.
 */
import type { CliOperation } from "./cli.js";
import { InstallerError } from "./errors.js";

export interface OperationalCommandOperations {
  readonly assertHostPrerequisites: () => Promise<void>;
  readonly doctor: () => Promise<unknown>;
  readonly logs: (lines: number) => Promise<unknown>;
  readonly ownerBootstrap: () => Promise<unknown>;
  readonly restart: () => Promise<unknown>;
  readonly status: () => Promise<unknown>;
}

function requireNoArguments(command: string, args: readonly string[]): void {
  if (args.length !== 0) {
    throw new InstallerError(
      "OSINARA_CLI_ARGUMENT_INVALID",
      `Команда ${command} не принимает аргументы`,
    );
  }
}

export function createOperationalCommands(
  operations: OperationalCommandOperations,
): Record<"doctor" | "logs" | "owner-bootstrap" | "restart" | "status", CliOperation> {
  return {
    doctor: async (args) => {
      requireNoArguments("doctor", args);
      await operations.assertHostPrerequisites();
      return await operations.doctor();
    },
    logs: async (args) => {
      const lines = args.length === 1 ? Number(args[0]) : Number.NaN;
      if (!Number.isInteger(lines) || lines < 1 || lines > 200) {
        throw new InstallerError(
          "OSINARA_CLI_ARGUMENT_INVALID",
          "Использование: osinara logs ЧИСЛО_СТРОК, от 1 до 200",
        );
      }
      await operations.assertHostPrerequisites();
      return await operations.logs(lines);
    },
    "owner-bootstrap": async (args) => {
      requireNoArguments("owner-bootstrap", args);
      await operations.assertHostPrerequisites();
      return await operations.ownerBootstrap();
    },
    restart: async (args) => {
      requireNoArguments("restart", args);
      await operations.assertHostPrerequisites();
      return await operations.restart();
    },
    status: async (args) => {
      requireNoArguments("status", args);
      await operations.assertHostPrerequisites();
      return await operations.status();
    },
  };
}
