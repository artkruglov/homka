/**
 * Deterministic Eve agent for PostgreSQL world stress verification.
 *
 * Constructs:
 * - Official PostgreSQL world using the same pinned runtime package as Osinara.
 * - Mock model that performs exactly one recorded side effect per turn.
 * - Large deterministic replies that exercise persisted stream growth without provider cost.
 */
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

const STRESS_REPLY_BYTES = 2_048;
const STRESS_CONTEXT_WINDOW_TOKENS = 1_000_000;
const STRESS_MESSAGE_PATTERN = /^stress-turn-(\d+)$/u;

function recordedCurrentTurn(
  toolResults: readonly { name: string; output: unknown }[],
  ordinal: number,
): boolean {
  return toolResults.some(({ name, output }) =>
    name === "record_turn" &&
    typeof output === "object" &&
    output !== null &&
    "ordinal" in output &&
    output.ordinal === ordinal
  );
}

const model = mockModel(({ lastUserMessage, toolResults }) => {
  const match = STRESS_MESSAGE_PATTERN.exec(lastUserMessage);
  if (!match) return "Invalid stress fixture input";
  const ordinal = Number(match[1]);

  // The first model step records a side effect; the post-tool step returns a sizeable final output.
  if (!recordedCurrentTurn(toolResults, ordinal)) {
    return {
      toolCalls: [{ input: { ordinal }, name: "record_turn" }],
    };
  }
  return `stress-reply-${ordinal}:${"x".repeat(STRESS_REPLY_BYTES)}`;
});

export default defineAgent({
  build: {
    externalDependencies: ["@workflow/world-postgres"],
  },
  experimental: {
    workflow: {
      world: "@workflow/world-postgres",
    },
  },
  limits: {
    // The gate targets Workflow replay, not Eve's independent cumulative provider-cost prompt.
    maxInputTokensPerSession: false,
  },
  model,
  modelContextWindowTokens: STRESS_CONTEXT_WINDOW_TOKENS,
});
