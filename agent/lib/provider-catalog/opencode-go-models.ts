/**
 * Maintained OpenCode Go model protocol catalog.
 *
 * Exports:
 * - `getOpenCodeGoProtocol`: resolves only IDs documented for supported installer protocols.
 *
 * Key constructs:
 * - `OPEN_CODE_GO_PROTOCOLS`: exact protocol map maintained from official OpenCode Go docs.
 */
import type { ProviderProtocol } from "./provider-catalog-types.js";

/**
 * Source: https://opencode.ai/docs/go/ (checked 2026-08-12).
 * GPT 5.6 Luna is intentionally absent because it requires the unsupported Responses API.
 */
const OPEN_CODE_GO_PROTOCOLS = {
  "deepseek-v4-flash": "openai-chat-completions",
  "deepseek-v4-pro": "openai-chat-completions",
  "glm-5.1": "openai-chat-completions",
  "glm-5.2": "openai-chat-completions",
  "grok-4.5": "openai-chat-completions",
  "hy3": "openai-chat-completions",
  "kimi-k2.6": "openai-chat-completions",
  "kimi-k2.7-code": "openai-chat-completions",
  "kimi-k3": "openai-chat-completions",
  "mimo-v2.5": "openai-chat-completions",
  "mimo-v2.5-pro": "openai-chat-completions",
  "minimax-m2.5": "anthropic-messages",
  "minimax-m2.7": "anthropic-messages",
  "minimax-m3": "anthropic-messages",
  "qwen3.6-plus": "anthropic-messages",
  "qwen3.7-max": "anthropic-messages",
  "qwen3.7-plus": "anthropic-messages",
  "qwen3.8-max": "anthropic-messages",
} as const satisfies Record<string, ProviderProtocol>;

/** Unknown IDs are excluded rather than assigned a protocol from naming conventions. */
export function getOpenCodeGoProtocol(modelId: string): ProviderProtocol | null {
  if (!Object.hasOwn(OPEN_CODE_GO_PROTOCOLS, modelId)) {
    return null;
  }

  return OPEN_CODE_GO_PROTOCOLS[modelId as keyof typeof OPEN_CODE_GO_PROTOCOLS];
}
