/**
 * Internal Google Workspace persistence mappings.
 *
 * Exports:
 * - `CompleteAuthorizationInput`: validated OAuth material persisted after callback completion.
 * - `AccountRow` and `CredentialRow`: exact PostgreSQL result shapes.
 * - `googleAccountFromRow`: maps persistence metadata without exposing token columns.
 * - `googleOAuthStateHash`: validates and hashes one-time OAuth state secrets.
 */
import { createHash } from "node:crypto";

import { AppError } from "../app-error.js";
import type { GoogleIntegrationAccount } from "./google-integration-contract.js";

export interface CompleteAuthorizationInput {
  accessToken: string;
  accessTokenExpiresAt: Date;
  displayName: string;
  encryptionKey: string;
  externalAccountId: string;
  refreshToken: string;
  scopes: string[];
}

export interface AccountRow {
  display_name: string;
  external_account_id: string;
  id: string;
  is_default: boolean;
  status: "active" | "reauth_required" | "revoked";
}

export interface CredentialRow extends AccountRow {
  access_token_auth_tag: string;
  access_token_ciphertext: string;
  access_token_expires_at: Date;
  access_token_nonce: string;
  refresh_token_auth_tag: string;
  refresh_token_ciphertext: string;
  refresh_token_nonce: string;
  scopes: string[];
}

export function googleOAuthStateHash(rawState: string): string {
  // Short values cannot carry the required entropy and must fail before reaching PostgreSQL.
  if (rawState.length < 16) {
    throw new AppError(
      "AGENT_GOOGLE_OAUTH_STATE_INVALID",
      "Ссылка авторизации Google недействительна. Запросите новую ссылку в Telegram",
    );
  }
  return createHash("sha256").update(rawState).digest("hex");
}

export function googleAccountFromRow(row: AccountRow): GoogleIntegrationAccount {
  return {
    displayName: row.display_name,
    externalAccountId: row.external_account_id,
    id: row.id,
    isDefault: row.is_default,
    status: row.status,
  };
}
