/**
 * Root-controller adapter for the canonical model-provider schema.
 *
 * Exports:
 * - `ModelProviderConfigV4`: canonical validated model selection contract.
 * - `parseModelProviderConfigBytes`: validates strict UTF-8 JSON bytes.
 * - `toModelSelection`: derives the secret-free current selection view.
 */
import {
  parseModelProviderConfig,
  type ModelProviderConfig as ModelProviderConfigV4,
} from "../../agent/lib/model-provider-config-schema.js";

import type { ModelSelection } from "./contracts.js";
import { modelConfigError } from "./errors.js";

export type { ModelProviderConfigV4 };

export function parseModelProviderConfigBytes(source: Buffer): ModelProviderConfigV4 {
  let decoded: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(source);
    decoded = JSON.parse(text);
  } catch {
    throw modelConfigError(
      "OSINARA_MODEL_CONFIG_JSON_INVALID",
      "Конфигурация модели должна быть корректным UTF-8 JSON; исправьте файл и повторите операцию",
    );
  }
  try {
    return parseModelProviderConfig(decoded);
  } catch {
    throw modelConfigError(
      "OSINARA_MODEL_CONFIG_SCHEMA_INVALID",
      "Конфигурация не соответствует точной schema v4",
    );
  }
}

export function toModelSelection(config: ModelProviderConfigV4): ModelSelection {
  return {
    primaryModelId: config.agent.models.primary.id,
    provider: config.provider,
    visionEnabled: config.agent.models.vision.supportsImageInput,
    voiceEnabled: config.voice.enabled,
  };
}
