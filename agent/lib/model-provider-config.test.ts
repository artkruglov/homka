/**
 * Runtime model-provider configuration tests.
 *
 * Constructs covered:
 * - `parseModelProviderConfig`: validates protocol-native agent transports and model IDs.
 * - Anthropic Messages and OpenAI Chat Completions remain provider-name independent.
 * - Required endpoint, authentication, thinking, capability, and context metadata fail fast.
 * - MiniMax and OpenCode Go transports enforce their exact protocol-native cross-field contracts.
 * - Codex subscription transport is limited to the internal CLIProxy service boundary.
 * - Voice-enabled startup requires an explicit Groq credential.
 * - Canonical runtime output limits reject values above the application-tested cap.
 * - Active schema is the host-mounted provider selection contract.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  parseModelProviderConfig,
  validateModelProviderRuntimeEnvironment,
} from "./model-provider-config-schema.js";

const validConfig = {
  agent: {
    models: {
      primary: { contextWindowTokens: 1_000_000, id: "MiniMax-M3", maxOutputTokens: 128_000 },
      vision: { id: "MiniMax-M3", maxOutputTokens: 128_000, supportsImageInput: true },
    },
    transport: {
      authentication: "bearer",
      baseUrl: "https://api.minimax.io/anthropic/v1",
      compatibility: "minimax-anthropic",
      protocol: "anthropic-messages",
      reasoning: { mode: "adaptive", type: "enabled" },
    },
  },
  provider: "minimax",
  schemaVersion: 4,
  voice: { enabled: true, transcriptionModelId: "whisper-large-v3-turbo" },
} as const;

describe("parseModelProviderConfig", () => {
  it("accepts only the fixed NeuralDeep OpenAI-compatible transport", () => {
    const neuraldeep = {
      ...validConfig,
      agent: {
        ...validConfig.agent,
        transport: {
          baseUrl: "https://api.neuraldeep.ru/v1",
          protocol: "openai-chat-completions",
          providerName: "neuraldeep",
          reasoning: null,
        },
      },
      provider: "neuraldeep",
    } as const;

    expect(parseModelProviderConfig(neuraldeep)).toEqual(neuraldeep);
    expect(() => parseModelProviderConfig({
      ...neuraldeep,
      agent: {
        ...neuraldeep.agent,
        transport: { ...neuraldeep.agent.transport, providerName: "openrouter" },
      },
    })).toThrow("AGENT_MODEL_PROVIDER_CONFIG_INVALID");
  });

  it("accepts only the fixed Groq transport with explicit reasoning effort", () => {
    const groq = {
      ...validConfig,
      agent: {
        models: {
          primary: {
            contextWindowTokens: 131_042,
            id: "qwen/qwen3.8-27b",
            maxOutputTokens: 16_384,
          },
          vision: {
            id: "qwen/qwen3.8-27b",
            maxOutputTokens: 16_384,
            reasoningEffort: "low",
            supportsImageInput: true,
          },
        },
        transport: {
          baseUrl: "https://api.groq.com/openai/v1",
          protocol: "openai-chat-completions",
          providerName: "groq",
          reasoning: { effort: "low", format: "reasoning-effort", type: "effort" },
        },
      },
      provider: "groq",
    } as const;

    expect(parseModelProviderConfig(groq)).toEqual(groq);
    for (const transport of [
      { ...groq.agent.transport, baseUrl: "https://api.groq.com/openai" },
      { ...groq.agent.transport, providerName: "openrouter" },
      {
        ...groq.agent.transport,
        reasoning: { effort: "low", format: "reasoning-object", type: "effort" },
      },
      { ...groq.agent.transport, reasoning: null },
    ]) {
      expect(() => parseModelProviderConfig({
        ...groq,
        agent: { ...groq.agent, transport },
      })).toThrow("AGENT_MODEL_PROVIDER_CONFIG_INVALID");
    }
  });

  it("loads the same active schema that production mounts for the agent", async () => {
    const active = JSON.parse(await readFile("config/agent-model-providers.json", "utf8"));

    expect(parseModelProviderConfig(active)).toEqual(active);
  });

  it("accepts protocol-native primary, vision, and voice model selection", () => {
    expect(parseModelProviderConfig(validConfig)).toEqual(validConfig);
  });

  it("accepts the native DeepSeek Responses transport only on the DeepSeek host", () => {
    const responses = {
      ...validConfig,
      agent: {
        models: {
          primary: { contextWindowTokens: 1_000_000, id: "deepseek-v4-flash", maxOutputTokens: 128_000 },
          vision: { supportsImageInput: false },
        },
        transport: {
          baseUrl: "https://api.deepseek.com",
          protocol: "deepseek-responses",
          reasoning: { effort: "none" },
        },
      },
      provider: "deepseek",
    } as const;
    expect(parseModelProviderConfig(responses)).toEqual(responses);
    expect(() => parseModelProviderConfig({
      ...responses,
      agent: { ...responses.agent, transport: { ...responses.agent.transport, baseUrl: "https://api.deepseek.com/anthropic" } },
    })).toThrow("AGENT_MODEL_PROVIDER_CONFIG_INVALID");
    expect(() => parseModelProviderConfig({
      ...responses,
      agent: { ...responses.agent, transport: { ...responses.agent.transport, reasoning: { effort: "medium" } } },
    })).toThrow("AGENT_MODEL_PROVIDER_CONFIG_INVALID");
    expect(() => parseModelProviderConfig({ ...responses, provider: "groq" })).toThrow("AGENT_MODEL_PROVIDER_CONFIG_INVALID");
  });

  it("accepts DeepSeek over its Anthropic-compatible endpoint as well as Chat Completions", () => {
    const deepseekAnthropic = {
      ...validConfig,
      agent: {
        models: {
          primary: { contextWindowTokens: 1_000_000, id: "deepseek-v4-flash", maxOutputTokens: 128_000 },
          vision: { supportsImageInput: false },
        },
        transport: {
          authentication: "api-key",
          baseUrl: "https://api.deepseek.com/anthropic",
          protocol: "anthropic-messages",
          reasoning: { mode: "adaptive", type: "enabled" },
        },
      },
      provider: "deepseek",
    } as const;
    expect(parseModelProviderConfig(deepseekAnthropic)).toEqual(deepseekAnthropic);
    expect(() => parseModelProviderConfig({
      ...deepseekAnthropic,
      agent: {
        ...deepseekAnthropic.agent,
        transport: { ...deepseekAnthropic.agent.transport, baseUrl: "https://api.minimax.io/anthropic/v1" },
      },
    })).toThrow("AGENT_MODEL_PROVIDER_CONFIG_INVALID");
    expect(() => parseModelProviderConfig({
      ...deepseekAnthropic,
      agent: {
        ...deepseekAnthropic.agent,
        transport: { ...deepseekAnthropic.agent.transport, compatibility: "minimax-anthropic" },
      },
    })).toThrow("AGENT_MODEL_PROVIDER_CONFIG_INVALID");
  });

  it("accepts only the exact MiniMax Anthropic transport contract", () => {
    expect(parseModelProviderConfig(validConfig)).toEqual(validConfig);
    expect(() => parseModelProviderConfig({
      ...validConfig,
      agent: {
        ...validConfig.agent,
        transport: {
          ...validConfig.agent.transport,
          authentication: "api-key",
        },
      },
    })).toThrow("AGENT_MODEL_PROVIDER_CONFIG_INVALID");
    expect(() => parseModelProviderConfig({
      ...validConfig,
      agent: {
        ...validConfig.agent,
        transport: {
          authentication: "bearer",
          baseUrl: "https://api.minimax.io/anthropic/v1",
          protocol: "anthropic-messages",
          reasoning: { mode: "adaptive", type: "enabled" },
        },
      },
    })).toThrow("AGENT_MODEL_PROVIDER_CONFIG_INVALID");
  });

  it("accepts both OpenCode Go protocols only with their exact auth and reasoning format", () => {
    const openAi = {
      ...validConfig,
      agent: {
        models: {
          primary: {
            contextWindowTokens: 1_000_000,
            id: "deepseek-v4-flash",
            maxOutputTokens: 128_000,
          },
          vision: { supportsImageInput: false },
        },
        transport: {
          baseUrl: "https://opencode.ai/zen/go/v1",
          protocol: "openai-chat-completions",
          providerName: "opencode-go",
          reasoning: { effort: "high", format: "reasoning-effort", type: "effort" },
        },
      },
      provider: "opencode-go",
    } as const;
    const anthropic = {
      ...openAi,
      agent: {
        models: {
          primary: {
            contextWindowTokens: 1_000_000,
            id: "minimax-m3",
            maxOutputTokens: 128_000,
          },
          vision: { supportsImageInput: false },
        },
        transport: {
          authentication: "bearer",
          baseUrl: "https://opencode.ai/zen/go/v1",
          protocol: "anthropic-messages",
          reasoning: { mode: "adaptive", type: "enabled" },
        },
      },
    } as const;

    expect(parseModelProviderConfig(openAi)).toEqual(openAi);
    expect(parseModelProviderConfig(anthropic)).toEqual(anthropic);
    expect(() => parseModelProviderConfig({
      ...openAi,
      agent: {
        ...openAi.agent,
        transport: { ...openAi.agent.transport, providerName: "openrouter" },
      },
    })).toThrow("AGENT_MODEL_PROVIDER_CONFIG_INVALID");
    expect(() => parseModelProviderConfig({
      ...openAi,
      agent: {
        ...openAi.agent,
        transport: {
          ...openAi.agent.transport,
          reasoning: { effort: "high", format: "reasoning-object", type: "effort" },
        },
      },
    })).toThrow("AGENT_MODEL_PROVIDER_CONFIG_INVALID");
    expect(() => parseModelProviderConfig({
      ...anthropic,
      agent: {
        ...anthropic.agent,
        transport: { ...anthropic.agent.transport, authentication: "api-key" },
      },
    })).toThrow("AGENT_MODEL_PROVIDER_CONFIG_INVALID");
  });

  it("accepts only the exact internal Codex subscription transport", () => {
    const codexSubscription = {
      ...validConfig,
      agent: {
        models: {
          primary: {
            contextWindowTokens: 372_000,
            id: "gpt-5.6-luna",
            maxOutputTokens: 128_000,
          },
          vision: {
            id: "gpt-5.6-luna",
            maxOutputTokens: 128_000,
            supportsImageInput: true,
          },
        },
        transport: {
          baseUrl: "http://cli-proxy-api:8317/v1",
          protocol: "openai-chat-completions",
          providerName: "codex-subscription",
          reasoning: { effort: "medium", format: "reasoning-effort", type: "effort" },
        },
      },
      provider: "codex-subscription",
    } as const;

    expect(parseModelProviderConfig(codexSubscription)).toEqual(codexSubscription);
    expect(() => parseModelProviderConfig({
      ...codexSubscription,
      agent: {
        ...codexSubscription.agent,
        transport: {
          ...codexSubscription.agent.transport,
          baseUrl: "http://untrusted-proxy:8317/v1",
        },
      },
    })).toThrow("AGENT_MODEL_PROVIDER_CONFIG_INVALID");
    expect(() => parseModelProviderConfig({
      ...codexSubscription,
      agent: {
        ...codexSubscription.agent,
        transport: {
          ...codexSubscription.agent.transport,
          reasoning: { effort: "high", format: "reasoning-object", type: "effort" },
        },
      },
    })).toThrow("AGENT_MODEL_PROVIDER_CONFIG_INVALID");
    expect(() => parseModelProviderConfig({
      ...codexSubscription,
      agent: {
        ...codexSubscription.agent,
        transport: {
          ...codexSubscription.agent.transport,
          reasoning: { effort: "low", format: "reasoning-effort", type: "effort" },
        },
      },
    })).toThrow("AGENT_MODEL_PROVIDER_CONFIG_INVALID");
    expect(() => parseModelProviderConfig({
      ...codexSubscription,
      agent: {
        ...codexSubscription.agent,
        transport: {
          ...codexSubscription.agent.transport,
          reasoning: { format: "reasoning-effort", type: "none" },
        },
      },
    })).toThrow("AGENT_MODEL_PROVIDER_CONFIG_INVALID");
  });

  it("accepts explicit local speech without sending audio to Groq", () => {
    const config = { ...validConfig, voice: { enabled: true, provider: "gigaam", transcriptionModelId: "multilingual_ctc" } };
    expect(() => validateModelProviderRuntimeEnvironment(config, {})).toThrow("AGENT_GIGAAM_API_KEY_REQUIRED");
    expect(validateModelProviderRuntimeEnvironment(config, { GIGAAM_API_KEY: "local-service-key" })).toEqual({ GROQ_API_KEY: undefined });
  });

  it("requires GROQ_API_KEY at startup only when voice is enabled", () => {
    expect(() => validateModelProviderRuntimeEnvironment(validConfig, {})).toThrow(
      "AGENT_GROQ_API_KEY_REQUIRED: Для включённого распознавания голосовых сообщений задайте GROQ_API_KEY",
    );
    expect(() => validateModelProviderRuntimeEnvironment(validConfig, {
      GROQ_API_KEY: "   ",
    })).toThrow("AGENT_GROQ_API_KEY_REQUIRED");
    expect(validateModelProviderRuntimeEnvironment(validConfig, {
      GROQ_API_KEY: "groq-secret",
    })).toEqual({ GROQ_API_KEY: "groq-secret" });
    expect(validateModelProviderRuntimeEnvironment({
      ...validConfig,
      voice: { enabled: false },
    }, {})).toEqual({ GROQ_API_KEY: undefined });
  });

  it("accepts a generic OpenAI-compatible transport without provider branching", () => {
    const config = {
      ...validConfig,
      agent: {
        ...validConfig.agent,
        transport: {
          baseUrl: "https://openrouter.ai/api/v1",
          protocol: "openai-chat-completions",
          providerName: "openrouter",
          reasoning: { effort: "high", format: "reasoning-object", type: "effort" },
        },
      },
      provider: "openrouter",
    };

    expect(parseModelProviderConfig(config)).toEqual(config);
  });

  it("accepts explicit DeepSeek thinking and an unavailable vision capability", () => {
    const config = {
      ...validConfig,
      agent: {
        models: {
          primary: {
            contextWindowTokens: 1_000_000,
            id: "deepseek-v4-flash",
            maxOutputTokens: 128_000,
          },
          vision: { supportsImageInput: false },
        },
        transport: {
          baseUrl: "https://api.deepseek.com",
          protocol: "openai-chat-completions",
          providerName: "deepseek",
          reasoning: { effort: "high", format: "deepseek", type: "effort" },
        },
      },
      provider: "deepseek",
    } as const;

    expect(parseModelProviderConfig(config)).toEqual(config);
  });

  it.each([
    { ...validConfig, schemaVersion: 3 },
    {
      ...validConfig,
      agent: {
        ...validConfig.agent,
        models: {
          ...validConfig.agent.models,
          primary: { contextWindowTokens: 0, id: "MiniMax-M3", maxOutputTokens: 128_000 },
        },
      },
    },
    {
      ...validConfig,
      agent: {
        ...validConfig.agent,
        models: {
          ...validConfig.agent.models,
          vision: { id: "", maxOutputTokens: 128_000, supportsImageInput: true },
        },
      },
    },
    {
      ...validConfig,
      agent: {
        ...validConfig.agent,
        transport: { ...validConfig.agent.transport, baseUrl: "http://api.minimax.io/v1" },
      },
    },
    {
      ...validConfig,
      agent: {
        ...validConfig.agent,
        transport: {
          ...validConfig.agent.transport,
          baseUrl: "https://api.minimax.io/anthropic/v1/messages",
        },
      },
    },
    {
      ...validConfig,
      agent: {
        ...validConfig.agent,
        transport: { ...validConfig.agent.transport, protocol: "unknown" },
      },
    },
    {
      ...validConfig,
      agent: {
        ...validConfig.agent,
        transport: {
          baseUrl: "https://api.deepseek.com",
          protocol: "openai-chat-completions",
          providerName: "deepseek",
        },
      },
    },
    { ...validConfig, agent: { ...validConfig.agent, unexpected: true } },
    { ...validConfig, provider: "unknown" },
    { ...validConfig, voice: { enabled: true, transcriptionModelId: "" } },
    {
      ...validConfig,
      agent: {
        ...validConfig.agent,
        models: {
          ...validConfig.agent.models,
          primary: { ...validConfig.agent.models.primary, maxOutputTokens: 128_001 },
        },
      },
    },
  ])("rejects invalid or ambiguous required config %#", (input) => {
    expect(() => parseModelProviderConfig(input)).toThrow(
      "AGENT_MODEL_PROVIDER_CONFIG_INVALID",
    );
  });
});
