/**
 * Shared removal of the forward-looking consequence from a settled approval prompt.
 *
 * Exports:
 * - `settledPromptText`: the stored prompt without its "будет выполнено" sentence.
 * - `boundSettledPrompt`: shortens it to fit beside a resolution without splitting a surrogate pair.
 *
 * Key constructs:
 * - An approved, cancelled or expired prompt must not keep promising a future execution next to the
 *   line that says it will not happen. Only an exact known sentence is removed, so a prompt composed
 *   by an older release is left intact rather than truncated.
 */
import { allApprovalConsequences } from "./approval-consequences.js";
import { stripApprovalConsequence } from "./approval-message.js";

export function settledPromptText(prompt: string): string {
  return stripApprovalConsequence(prompt, allApprovalConsequences());
}

/**
 * Shortens a settled prompt to `limit` characters. A UTF-16 surrogate pair is never split: Telegram
 * rejects a malformed payload, which would leave the decided prompt showing its old buttons.
 */
export function boundSettledPrompt(prompt: string, limit: number): string {
  if (limit <= 0) return "";
  if (prompt.length <= limit) return prompt;
  let end = limit - 1;
  if (/[\uD800-\uDBFF]/u.test(prompt[end - 1] ?? "")) end -= 1;
  return `${prompt.slice(0, end).trimEnd()}…`;
}
