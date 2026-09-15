/**
 * Root Eve agent configuration.
 *
 * Constructs:
 * - Explicit primary model from the multi-provider registry.
 * - Fail-closed per-turn model step limit and NeuralDeep routing for upstream KV-cache reuse.
 * - Context compaction; Eve exposes its native fresh-context child only to root sessions.
 * - Official PostgreSQL Workflow world retained as an external runtime dependency.
 */
import { defineAgent, defineDynamic } from "eve";

import {
  AGENT_COMPACTION_CONTEXT_WINDOW_TOKENS,
  AGENT_COMPACTION_THRESHOLD,
  AGENT_MAX_MODEL_STEPS_PER_TURN,
} from "./config.js";
import { installSecretRedaction } from "./lib/logging/redact-secrets.js";
import { primaryModel } from "./lib/model-registry.js";
import { modelProviderConfig } from "./lib/model-provider-config.js";
import { resolveSessionModelSelection } from "./lib/neuraldeep-session-routing.js";
import { resolveTurnModelStepLimitSelection } from "./lib/turn-model-step-limit.js";

// Журналы это сырой console из сотен мест: вырезание секретов стоит на самом выходе, иначе
// однажды одно место забудут. Установка идёт при загрузке агента, то есть до первого хода.
installSecretRedaction();

// Eve derives the compaction threshold from the runtime-selected model's window, so the same
// capped value must reach both the static compaction config and the per-step model selection.
const primaryModelContextWindowTokens = Math.min(
  modelProviderConfig.agent.models.primary.contextWindowTokens,
  AGENT_COMPACTION_CONTEXT_WINDOW_TOKENS,
);

export default defineAgent({
  build: {
    externalDependencies: ["@workflow/world-postgres"],
  },
  compaction: {
    modelContextWindowTokens: primaryModelContextWindowTokens,
    thresholdPercent: AGENT_COMPACTION_THRESHOLD,
  },
  experimental: {
    workflow: {
      world: "@workflow/world-postgres",
    },
  },
  model: defineDynamic({
    events: {
      "step.started": (event, ctx) => {
        // Resolve the guard first: resolver exceptions would let Eve silently use its fallback.
        const blockedSelection = resolveTurnModelStepLimitSelection({
          event,
          maxModelSteps: AGENT_MAX_MODEL_STEPS_PER_TURN,
          model: primaryModel,
          modelContextWindowTokens: primaryModelContextWindowTokens,
        });
        if (blockedSelection !== null) return blockedSelection;

        return resolveSessionModelSelection({
          model: primaryModel,
          modelContextWindowTokens: primaryModelContextWindowTokens,
          providerId: modelProviderConfig.provider,
          sessionId: ctx.session.id,
        });
      },
    },
  }),
});
