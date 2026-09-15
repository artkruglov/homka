/**
 * Privileged subprocess diagnostics tests.
 *
 * Constructs covered:
 * - `runHostCommand`: bounded, useful stderr diagnostics with credential redaction.
 */
import { describe, expect, it } from "vitest";

import { runHostCommand } from "./process-runner.js";

describe("runHostCommand", () => {
  it("reports bounded stderr context without exposing secrets", async () => {
    const failure = runHostCommand({
      args: [
        "-e",
        "process.stderr.write('MODEL_API_KEY=super-secret-value\\nAuthorization: Bearer bearer-secret\\n' + 'x'.repeat(5000) + '\\nservice unhealthy\\n'); process.exit(7)",
      ],
      command: process.execPath,
      timeoutMs: 5_000,
    });

    await expect(failure).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : "";
      return message.includes("service unhealthy")
        && message.includes("[СКРЫТО]")
        && !message.includes("super-secret-value")
        && !message.includes("bearer-secret")
        && message.length < 3_000;
    });
  });
});
