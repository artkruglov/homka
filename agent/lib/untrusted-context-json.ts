/**
 * Shared serialization for untrusted values placed inside model-context boundaries.
 *
 * Export:
 * - `escapeUntrustedContextJson`: JSON with markup characters neutralized.
 */

// Every untrusted block (timeline, attachments, deliveries, retrieved memory) is delimited by an
// XML-like tag. Escaping markup characters keeps participant text from closing its own boundary or
// forging a trusted block, while JSON.parse still restores the exact original value downstream.
export function escapeUntrustedContextJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
}
