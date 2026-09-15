/**
 * Read-only Google Workspace account repository.
 *
 * Export:
 * - `googleAccountRepository.getDefaultAccount`: returns the live authorized decrypted account.
 */
import { database } from "../database.js";
import type { PoolClient } from "pg";
import { assertGoogleWorkspaceAccess } from "./google-integration-access.js";
import type {
  DecryptedGoogleAccount,
  GoogleIntegrationAuthorization,
} from "./google-integration-contract.js";
import {
  type CredentialRow,
  googleAccountFromRow,
} from "./google-integration-persistence.js";
import { decryptGoogleToken } from "./google-token-crypto.js";

const GOOGLE_WORKSPACE_PROVIDER = "google_workspace";

async function loadDefaultAccount(
  client: PoolClient,
  workspaceId: string,
  encryptionKey: string,
): Promise<DecryptedGoogleAccount | null> {
  const result = await client.query<CredentialRow>(
    `SELECT account.id, account.external_account_id, account.display_name, account.status,
            account.is_default, account.scopes,
            credential.refresh_token_ciphertext, credential.refresh_token_nonce,
            credential.refresh_token_auth_tag, credential.access_token_ciphertext,
            credential.access_token_nonce, credential.access_token_auth_tag,
            credential.access_token_expires_at
     FROM integration_accounts AS account
     JOIN integration_credentials AS credential ON credential.account_id = account.id
     WHERE account.workspace_id = $1 AND account.provider = $2
       AND account.is_default AND account.status = 'active'`,
    [workspaceId, GOOGLE_WORKSPACE_PROVIDER],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    ...googleAccountFromRow(row),
    accessToken: decryptGoogleToken({
      authTag: row.access_token_auth_tag,
      ciphertext: row.access_token_ciphertext,
      nonce: row.access_token_nonce,
    }, encryptionKey),
    accessTokenExpiresAt: row.access_token_expires_at,
    refreshToken: decryptGoogleToken({
      authTag: row.refresh_token_auth_tag,
      ciphertext: row.refresh_token_ciphertext,
      nonce: row.refresh_token_nonce,
    }, encryptionKey),
    scopes: row.scopes,
  };
}

export const googleAccountRepository = {
  async getDefaultAccount(
    auth: GoogleIntegrationAuthorization,
    encryptionKey: string,
  ): Promise<DecryptedGoogleAccount | null> {
    const client = await database().connect();
    try {
      await assertGoogleWorkspaceAccess(client, auth, false);
      return await loadDefaultAccount(client, auth.workspaceId, encryptionKey);
    } finally {
      client.release();
    }
  },

  async withProfileAccount<T>(
    auth: GoogleIntegrationAuthorization,
    encryptionKey: string,
    management: boolean,
    operation: (account: DecryptedGoogleAccount | null) => Promise<T>,
  ): Promise<T> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await assertGoogleWorkspaceAccess(client, auth, management);
      await client.query("SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", [auth.workspaceId]);
      const account = await loadDefaultAccount(client, auth.workspaceId, encryptionKey);
      const value = await operation(account);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
