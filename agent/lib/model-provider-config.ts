/**
 * Runtime-selectable model transport configuration.
 *
 * Exports:
 * - Re-exports the canonical pure schema contracts and parser.
 * - `modelProviderConfig`: validated configuration loaded from the canonical runtime path.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  parseModelProviderConfig,
  type AgentModelTransport,
  type ModelProviderConfig,
  type ModelProviderId,
} from "./model-provider-config-schema.js";

export {
  parseModelProviderConfig,
  type AgentModelTransport,
  type ModelProviderConfig,
  type ModelProviderId,
} from "./model-provider-config-schema.js";

const MODEL_PROVIDER_CONFIG_PATH = resolve(process.cwd(), "config/agent-model-providers.json");

function loadModelProviderConfig(): ModelProviderConfig {
  try {
    const source = readFileSync(MODEL_PROVIDER_CONFIG_PATH, "utf8");
    return parseModelProviderConfig(JSON.parse(source));
  } catch (error) {
    // Keep the original filesystem/parser error while making startup diagnostics searchable.
    if (error instanceof Error && !error.message.includes("AGENT_MODEL_PROVIDER_CONFIG_INVALID")) {
      Object.defineProperty(error, "message", {
        configurable: true,
        value: `AGENT_MODEL_PROVIDER_CONFIG_INVALID: ${error.message}`,
        writable: true,
      });
    }
    throw error;
  }
}

export const modelProviderConfig = loadModelProviderConfig();
