/**
 * LLM provider registry tests.
 *
 * Constructs covered:
 * - `primaryModel`: server-configured protocol-native text route for the Eve agent loop.
 * - `visionModel`: absent when the active provider explicitly lacks image input.
 * - `voiceTranscriptionModel`: explicit Groq Whisper transcription route.
 */
import { describe, expect, it } from "vitest";

import { modelProviderConfig } from "./model-provider-config.js";
import { primaryModel, visionModel, visionTransport, voiceTranscriptionModel } from "./model-registry.js";

describe("model registry", () => {
  it("selects the configured protocol-native text model", () => {
    expect(modelProviderConfig.agent.transport.protocol).toBe("anthropic-messages");
    expect(primaryModel.modelId).toBe(modelProviderConfig.agent.models.primary.id);
    // The deployed DeepSeek Anthropic endpoint still executes server-side search.
    expect(primaryModel.provider).toBe("anthropic.messages");
  });

  it("does not construct a model that cannot accept image input", () => {
    expect(modelProviderConfig.agent.models.vision.supportsImageInput).toBe(false);
    expect(visionModel).toBeNull();
  });

  it("constructs voice transcription only when both config and credential enable it", () => {
    if (!process.env.GROQ_API_KEY || !modelProviderConfig.voice.enabled || modelProviderConfig.voice.provider === "gigaam") {
      expect(voiceTranscriptionModel).toBeNull();
      return;
    }
    expect(voiceTranscriptionModel?.modelId).toBe(modelProviderConfig.voice.transcriptionModelId);
    expect(voiceTranscriptionModel?.provider).toBe("groq.transcription");
  });

  it("gives the vision model its own reasoning effort only on the DeepSeek Responses transport", () => {
    const transport = {
      baseUrl: "https://api.deepseek.com",
      protocol: "deepseek-responses" as const,
      reasoning: { effort: "max" as const },
    };
    const vision = { id: "deepseek-v4-flash-vision-exp", maxOutputTokens: 128_000, reasoningEffort: "high" as const, supportsImageInput: true as const };
    expect(visionTransport(transport, vision)).toEqual({ ...transport, reasoning: { effort: "high" } });
    expect(visionTransport(transport, { ...vision, reasoningEffort: undefined })).toBe(transport);
    expect(visionTransport(transport, { supportsImageInput: false })).toBe(transport);
    const chat = {
      baseUrl: "https://api.groq.com/openai/v1",
      protocol: "openai-chat-completions" as const,
      providerName: "groq" as const,
      reasoning: { effort: "low" as const, format: "reasoning-effort" as const, type: "effort" as const },
    };
    expect(visionTransport(chat as never, vision)).toBe(chat);
  });
});
