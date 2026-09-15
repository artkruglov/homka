/**
 * First-owner bootstrap process output contract.
 *
 * Exports:
 * - `serializeBootstrapCodeOutput`: emits one strict machine-readable executor result.
 */
export function serializeBootstrapCodeOutput(input: {
  readonly code: string;
  readonly expiresAt: Date;
}): string {
  return `${JSON.stringify({
    bootstrapCode: input.code,
    bootstrapExpiresAt: input.expiresAt.toISOString(),
  })}\n`;
}
