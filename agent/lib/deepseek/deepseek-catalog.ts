/**
 * DeepSeek model catalog (api-docs.deepseek.com/quick_start/pricing, rate_limit).
 *
 * Exports:
 * - `DEEPSEEK_MODELS`: documented ids, windows, output ceilings, capabilities and concurrency.
 * - `DEEPSEEK_RESPONSES_BASE_URL`, `DEEPSEEK_RESPONSES_PATH`: the native endpoint.
 * - `DEEPSEEK_INFERENCE_START_TIMEOUT_MILLISECONDS`: server closes idle requests after this.
 */
export const DEEPSEEK_RESPONSES_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_RESPONSES_PATH = "/responses";
export const DEEPSEEK_INFERENCE_START_TIMEOUT_MILLISECONDS = 10 * 60 * 1_000;

export interface DeepSeekModelDescriptor {
  readonly concurrency: number;
  readonly contextWindowTokens: number;
  readonly id: string;
  readonly maxOutputTokens: number;
  readonly supportsImageInput: boolean;
  readonly supportsThinking: boolean;
  readonly supportsWebSearch: boolean;
}

export const DEEPSEEK_MODELS: readonly DeepSeekModelDescriptor[] = [
  {
    concurrency: 2_500,
    contextWindowTokens: 1_000_000,
    id: "deepseek-v4-flash",
    maxOutputTokens: 384_000,
    supportsImageInput: false,
    supportsThinking: true,
    supportsWebSearch: true,
  },
  {
    // Preview alias of V4.1 flash seen on 9 September 2026; DeepSeek retires it on the date in
    // the id. The transport falls back to deepseek-v4-flash when the id is gone.
    concurrency: 2_500,
    contextWindowTokens: 1_000_000,
    id: "deepseek-v4.1-flash-expires-on-0910",
    maxOutputTokens: 384_000,
    supportsImageInput: false,
    supportsThinking: true,
    supportsWebSearch: true,
  },
  {
    concurrency: 500,
    contextWindowTokens: 1_000_000,
    id: "deepseek-v4-pro",
    maxOutputTokens: 384_000,
    supportsImageInput: false,
    supportsThinking: true,
    supportsWebSearch: true,
  },
  {
    concurrency: 2_500,
    contextWindowTokens: 1_000_000,
    id: "deepseek-v4-flash-vision-exp",
    maxOutputTokens: 384_000,
    supportsImageInput: true,
    supportsThinking: true,
    supportsWebSearch: true,
  },
];

export function findDeepSeekModel(id: string): DeepSeekModelDescriptor | null {
  return DEEPSEEK_MODELS.find((model) => model.id === id) ?? null;
}
