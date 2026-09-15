/**
 * Provider installer error contract.
 *
 * Exports:
 * - `InstallerError`: stable code plus human-readable Russian installer failure.
 * - `isInstallerError`: safe CLI-boundary narrowing for expected failures.
 */
export class InstallerError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = "InstallerError";
    this.code = code;
  }
}

export function isInstallerError(error: unknown): error is InstallerError {
  return error instanceof InstallerError;
}
