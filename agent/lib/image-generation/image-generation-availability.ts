/**
 * Runtime availability gate for subscription-backed image generation.
 *
 * Exports:
 * - `supportsSubscriptionImageGeneration`: pure provider capability check.
 * - `IMAGE_GENERATION_AVAILABLE`: availability for the active validated runtime config.
 */
import { modelProviderConfig, type ModelProviderId } from "../model-provider-config.js";
import { createCloudflareImageClient, createNeuralDeepImageClient } from "./flux-image-clients.js";

export function supportsSubscriptionImageGeneration(provider: ModelProviderId): boolean {
  return provider === "codex-subscription";
}

export type ImageGenerationEnvironment = Readonly<Record<string, string | undefined>>;

function configured(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function supportsCloudflareImageGeneration(environment: ImageGenerationEnvironment): boolean {
  return configured(environment.CLOUDFLARE_ACCOUNT_ID) && configured(environment.CLOUDFLARE_AI_TOKEN);
}

export function supportsNeuralDeepImageGeneration(environment: ImageGenerationEnvironment): boolean {
  return configured(environment.NEURALDEEP_IMAGE_API_KEY);
}

export function supportsOpenRouterImageGeneration(environment: ImageGenerationEnvironment): boolean {
  return configured(environment.OPENROUTER_IMAGE_API_KEY) && configured(environment.OPENROUTER_IMAGE_MODEL);
}

/** Ordered Flux providers: the free Cloudflare quota first, NeuralDeep once it is exhausted or down. */
export function resolveFluxImageProviders(environment: ImageGenerationEnvironment) {
  const chain = [];
  if (supportsCloudflareImageGeneration(environment)) {
    chain.push(createCloudflareImageClient({
      accountId: environment.CLOUDFLARE_ACCOUNT_ID!.trim(),
      token: environment.CLOUDFLARE_AI_TOKEN!.trim(),
    }));
  }
  if (supportsNeuralDeepImageGeneration(environment)) {
    chain.push(createNeuralDeepImageClient({ apiKey: environment.NEURALDEEP_IMAGE_API_KEY!.trim() }));
  }
  return chain;
}

export function supportsImageGeneration(
  provider: ModelProviderId,
  environment: ImageGenerationEnvironment,
): boolean {
  return supportsSubscriptionImageGeneration(provider) ||
    supportsOpenRouterImageGeneration(environment) ||
    supportsCloudflareImageGeneration(environment) ||
    supportsNeuralDeepImageGeneration(environment);
}

export const IMAGE_GENERATION_AVAILABLE = supportsImageGeneration(
  modelProviderConfig.provider,
  process.env,
);
