/**
 * Automatic memory content safety policy.
 *
 * Exports:
 * - `memoryContentRejectionCode`: rejects secrets and payment credentials before claim writing.
 * - `requireAllowedMemoryContent`: shared fail-fast policy for every manual/automatic writer.
 */
import { AppError } from "./app-error.js";

const PRIVATE_KEY_PATTERN = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/u;
const CREDENTIAL_ASSIGNMENT_PATTERN = /(?:api[_ -]?key|access[_ -]?token|secret|password|парол[ья])\s*(?::|=|\s)\s*\S{8,}/iu;
const CVV_PATTERN = /(?:cvv|cvc|код\s+с\s+оборот[а-я]*)\s*[:=]?\s*\d{3,4}(?!\d)/iu;
const ONE_TIME_CODE_PATTERN = /(?:одноразов(?:ый|ого)\s+код|otp|2fa)\s*[:=]?\s*\d{4,8}(?!\d)/iu;
const PAYMENT_CARD_CANDIDATE_PATTERN = /(?:\d[ -]?){13,19}/gu;

function luhn(value: string): boolean {
  const digits = value.replace(/\D/gu, "");
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/u.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

export function memoryContentRejectionCode(content: string): string | null {
  if (PRIVATE_KEY_PATTERN.test(content) || CREDENTIAL_ASSIGNMENT_PATTERN.test(content)) {
    return "AGENT_MEMORY_SECRET_REJECTED";
  }
  if (ONE_TIME_CODE_PATTERN.test(content)) return "AGENT_MEMORY_SECRET_REJECTED";
  if (CVV_PATTERN.test(content)) return "AGENT_MEMORY_PAYMENT_CREDENTIAL_REJECTED";
  const cardCandidates = content.match(PAYMENT_CARD_CANDIDATE_PATTERN) ?? [];
  return cardCandidates.some(luhn)
    ? "AGENT_MEMORY_PAYMENT_CREDENTIAL_REJECTED"
    : null;
}

export function requireAllowedMemoryContent(content: string): string {
  const rejectionCode = memoryContentRejectionCode(content);
  if (rejectionCode) {
    throw new AppError(
      "AGENT_MEMORY_CONTENT_FORBIDDEN",
      "Секреты и платёжные данные нельзя сохранять в долговременной памяти",
    );
  }
  return content;
}
