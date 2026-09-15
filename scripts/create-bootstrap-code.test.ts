/**
 * First-owner bootstrap CLI tests.
 *
 * Constructs covered:
 * - `serializeBootstrapCodeOutput`: emits one strict machine-readable executor contract.
 */
import { describe, expect, it } from "vitest";

import { serializeBootstrapCodeOutput } from "./create-bootstrap-code-output.js";

describe("serializeBootstrapCodeOutput", () => {
  it("emits only the one-time code and ISO expiry as JSON", () => {
    expect(serializeBootstrapCodeOutput({
      code: "bootstrap_secret-123",
      expiresAt: new Date("2026-08-13T12:15:00.000Z"),
    })).toBe(
      '{"bootstrapCode":"bootstrap_secret-123","bootstrapExpiresAt":"2026-08-13T12:15:00.000Z"}\n',
    );
  });
});
