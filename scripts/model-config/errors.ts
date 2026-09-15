/**
 * Model configuration error contract.
 *
 * Exports:
 * - `ModelConfigError`: stable code and human-readable Russian operational failure.
 * - `modelConfigError`: creates sanitized errors without retaining secret-bearing causes.
 */
export class ModelConfigError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ModelConfigError";
    this.code = code;
  }
}

export function modelConfigError(code: string, message: string): ModelConfigError {
  return new ModelConfigError(code, message);
}
