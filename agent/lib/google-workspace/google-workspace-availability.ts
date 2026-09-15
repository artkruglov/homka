/**
 * Runtime availability gate for the Google Workspace integration.
 *
 * Exports:
 * - `supportsGoogleWorkspace`: pure check that OAuth client credentials are configured.
 * - `GOOGLE_WORKSPACE_AVAILABLE`: availability for the current process environment.
 *
 * Key construct:
 * - Without OAuth client credentials no participant can connect an account, so advertising the
 *   Google tools and the nineteen gws skill packages would only cost prompt tokens and sandbox
 *   uploads on every session. The gate mirrors `IMAGE_GENERATION_AVAILABLE`.
 */
export type GoogleWorkspaceEnvironment = Readonly<Record<string, string | undefined>>;

function configured(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function supportsGoogleWorkspace(environment: GoogleWorkspaceEnvironment): boolean {
  return configured(environment.GOOGLE_OAUTH_CLIENT_ID) &&
    configured(environment.GOOGLE_OAUTH_CLIENT_SECRET);
}

export const GOOGLE_WORKSPACE_AVAILABLE = supportsGoogleWorkspace(process.env);
