/**
 * Shell commands the runner executes inside a sandbox container, built from untrusted paths.
 *
 * Exports:
 * - `shellQuote`: POSIX single-quote quoting; the shell expands nothing inside it.
 * - `assertShellSafePath`: control characters never reach a command or a log line.
 * - `stageFileForReadCommand`, `commitStagedFileCommand`, `prepareWriteDirectoriesCommand`,
 *   `removeStagedFileCommand`, `initializeToolEnvironmentCommand`: the exact command strings.
 * - `FILE_MISSING_EXIT_CODE`, `FILE_TOO_LARGE_EXIT_CODE`: the existence and size checks run in
 *   the container before any copy, so a large file is never staged and never doubles disk use.
 *
 * Key construct:
 * - Every path reaches `bash -c` inside single quotes. `JSON.stringify` used to be the quoting,
 *   and its double quotes leave `$(...)` and backticks live: a file name chosen by the model in an
 *   external group could run commands in the restricted container despite the Bash denial.
 */
export const FILE_MISSING_EXIT_CODE = 44;
export const FILE_TOO_LARGE_EXIT_CODE = 45;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

export function assertShellSafePath(path: string): void {
  if (CONTROL_CHARACTERS.test(path)) {
    throw new Error("AGENT_SANDBOX_RUNNER_PATH_INVALID: Path contains control characters");
  }
}

export function shellQuote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`;
}

export function stageFileForReadCommand(input: {
  maxBytes: number;
  resolvedPath: string;
  stagingDirectory: string;
  stagingPath: string;
}): string {
  const source = shellQuote(input.resolvedPath);
  return [
    `mkdir -p -- ${shellQuote(input.stagingDirectory)}`,
    `if [ ! -f ${source} ]; then exit ${FILE_MISSING_EXIT_CODE}; fi`,
    `if [ "$(stat -c %s -- ${source})" -gt ${Math.floor(input.maxBytes)} ]; then exit ${FILE_TOO_LARGE_EXIT_CODE}; fi`,
    `cp -T -- ${source} ${shellQuote(input.stagingPath)}`,
  ].join(" && ");
}

export function removeStagedFileCommand(stagingPath: string): string {
  return `rm -f -- ${shellQuote(stagingPath)}`;
}

export function prepareWriteDirectoriesCommand(input: {
  stagingDirectory: string;
  targetDirectory: string;
}): string {
  return `mkdir -p -- ${shellQuote(input.targetDirectory)} ${shellQuote(input.stagingDirectory)}`;
}

export function commitStagedFileCommand(input: { resolvedPath: string; stagingPath: string }): string {
  return `mv -T -- ${shellQuote(input.stagingPath)} ${shellQuote(input.resolvedPath)}`;
}

export function initializeToolEnvironmentCommand(input: {
  directories: readonly string[];
  pythonRoot: string;
}): string {
  return [
    `mkdir -p ${input.directories.map(shellQuote).join(" ")}`,
    `(test -x ${shellQuote(`${input.pythonRoot}/bin/python`)} || python3 -m venv ${shellQuote(input.pythonRoot)})`,
  ].join(" && ");
}
