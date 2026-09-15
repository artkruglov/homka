/**
 * Osinara CLI command router.
 *
 * Exports:
 * - `CLI_COMMANDS`: stable command surface.
 * - `runCli`: routes commands to injected adapters and maps failures to process exit codes.
 * - `unavailableOperation`: explicit fail-closed adapter for release wiring not yet shipped.
 */
import { InstallerError, isInstallerError } from "./errors.ts";

export const CLI_COMMANDS = [
  "install",
  "status",
  "config",
  "doctor",
  "logs",
  "restart",
  "owner-bootstrap",
] as const;

export type CliCommand = (typeof CLI_COMMANDS)[number];
export type CliOperation = (args: readonly string[]) => Promise<unknown>;

export interface CliDependencies {
  operations: Partial<Record<CliCommand, CliOperation>>;
  writeError: (message: string) => void;
  writeOutput: (message: string) => void;
}

const HELP = [
  "Использование:",
  "  osinara install",
  "  osinara status",
  "  osinara config",
  "  osinara doctor",
  "  osinara logs",
  "  osinara restart",
  "  osinara owner-bootstrap",
].join("\n");

function isCliCommand(value: string): value is CliCommand {
  return (CLI_COMMANDS as readonly string[]).includes(value);
}

export function unavailableOperation(command: CliCommand): CliOperation {
  return async () => {
    throw new InstallerError(
      "OSINARA_CLI_OPERATION_UNAVAILABLE",
      `Операция «${command}» недоступна: обязательный release adapter еще не подключен`,
    );
  };
}

export async function runCli(
  argv: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  const command = argv[0];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    dependencies.writeOutput(HELP);
    return 0;
  }
  if (!isCliCommand(command)) {
    dependencies.writeError(
      `OSINARA_CLI_COMMAND_INVALID: Неизвестная команда «${command}». Запустите osinara --help`,
    );
    return 2;
  }

  const operation = dependencies.operations[command] ?? unavailableOperation(command);
  try {
    const result = await operation(argv.slice(1));
    dependencies.writeOutput(JSON.stringify(result));
    return 0;
  } catch (error) {
    if (isInstallerError(error)) {
      dependencies.writeError(error.message);
      return 1;
    }
    dependencies.writeError(
      "OSINARA_CLI_OPERATION_FAILED: Операция завершилась непредвиденной ошибкой. Проверьте системный журнал",
    );
    return 1;
  }
}
