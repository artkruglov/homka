/**
 * Google Workspace availability gate tests.
 *
 * Constructs covered:
 * - Without OAuth client credentials nobody can connect an account, so the integration is off.
 * - Both credentials must be present and non-blank for the integration to be on.
 */
import { describe, expect, it } from "vitest";

import { supportsGoogleWorkspace } from "./google-workspace-availability.js";

describe("supportsGoogleWorkspace", () => {
  it("is on only when both OAuth client credentials are configured", () => {
    expect(supportsGoogleWorkspace({
      GOOGLE_OAUTH_CLIENT_ID: "client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
    })).toBe(true);
  });

  it("is off when either credential is missing or blank", () => {
    expect(supportsGoogleWorkspace({})).toBe(false);
    expect(supportsGoogleWorkspace({ GOOGLE_OAUTH_CLIENT_ID: "client-id" })).toBe(false);
    expect(supportsGoogleWorkspace({
      GOOGLE_OAUTH_CLIENT_ID: "client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "   ",
    })).toBe(false);
  });
});
