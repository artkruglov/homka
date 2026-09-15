/**
 * Family invitation codes.
 *
 * Exports:
 * - `createInvitationCode`: random one-time plaintext and persistable hash.
 * - `createInvitationCodeForOperation`: replay-stable code derived from a secret operation key.
 * - `hashInvitationCode`: deterministic lookup hash for high-entropy codes.
 * - `requireInvitationSigningSecret`: validates the dedicated runtime secret.
 * - `parseInvitationStartCommand`: extracts only a strict deep-link token for the current bot.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";

export const INVITATION_CODE_TTL_MS = 24 * 60 * 60 * 1000;
export const INVITATION_SIGNING_SECRET_MIN_LENGTH = 32;
const INVITATION_CODE_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const TELEGRAM_START_COMMAND_PATTERN =
  /^\/start(?:@(?<target>[A-Za-z0-9_]{5,32}))?\s+(?<token>[A-Za-z0-9_-]{32})$/u;

export function hashInvitationCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

export function createInvitationCode(now: Date): {
  code: string;
  codeHash: string;
  expiresAt: Date;
} {
  const code = randomBytes(24).toString("base64url");
  return {
    code,
    codeHash: hashInvitationCode(code),
    expiresAt: new Date(now.getTime() + INVITATION_CODE_TTL_MS),
  };
}

export function createInvitationCodeForOperation(
  operationKey: string,
  signingSecret: string,
): { code: string; codeHash: string } {
  // Twenty-four HMAC bytes preserve the original 192-bit token strength and 32-char payload.
  const code = createHmac("sha256", signingSecret)
    .update(operationKey, "utf8")
    .digest()
    .subarray(0, 24)
    .toString("base64url");
  return { code, codeHash: hashInvitationCode(code) };
}

export function requireInvitationSigningSecret(): string {
  const secret = process.env.INVITATION_SIGNING_SECRET;
  if (!secret || secret.length < INVITATION_SIGNING_SECRET_MIN_LENGTH) {
    throw new Error(
      `AGENT_INVITATION_CONFIG_MISSING: Секрет подписи приглашений должен содержать минимум ${INVITATION_SIGNING_SECRET_MIN_LENGTH} символа`,
    );
  }
  return secret;
}

export function parseInvitationStartCommand(text: string, botUsername: string): string | null {
  // Exact matching keeps arbitrary unknown-user messages out of the invitation verifier.
  const match = TELEGRAM_START_COMMAND_PATTERN.exec(text);
  const target = match?.groups?.target;
  if (target && target.toLowerCase() !== botUsername.toLowerCase()) return null;
  const token = match?.groups?.token;
  return token && INVITATION_CODE_PATTERN.test(token) ? token : null;
}
