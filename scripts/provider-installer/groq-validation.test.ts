/**
 * Groq voice credential validation tests.
 *
 * Constructs covered:
 * - `validateGroqVoiceCredential`: requires the official model shape and active transcription access.
 */
import { describe, expect, it, vi } from "vitest";

import { validateGroqVoiceCredential } from "./groq-validation.js";

describe("validateGroqVoiceCredential", () => {
  it("accepts only a catalog containing the configured transcription model", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{
        active: true,
        context_window: 448,
        created: 1_728_413_088,
        id: "whisper-large-v3-turbo",
        object: "model",
        owned_by: "OpenAI",
        public_apps: null,
      }],
      object: "list",
    }), { status: 200 }));

    await expect(validateGroqVoiceCredential({
      apiKey: "groq-secret",
      fetch,
      timeoutMs: 10_000,
    })).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith("https://api.groq.com/openai/v1/models", {
      headers: { authorization: "Bearer groq-secret" },
      signal: expect.any(AbortSignal),
    });
  });

  it("rejects a key without access to the exact transcription model", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [],
      object: "list",
    }), { status: 200 }));

    await expect(validateGroqVoiceCredential({
      apiKey: "groq-secret",
      fetch,
      timeoutMs: 10_000,
    })).rejects.toMatchObject({ code: "OSINARA_INSTALL_GROQ_MODEL_UNAVAILABLE" });
  });

  it("rejects the exact transcription model when Groq marks it inactive", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{
        active: false,
        context_window: 448,
        created: 1_728_413_088,
        id: "whisper-large-v3-turbo",
        object: "model",
        owned_by: "OpenAI",
      }],
      object: "list",
    }), { status: 200 }));

    await expect(validateGroqVoiceCredential({
      apiKey: "groq-secret",
      fetch,
      timeoutMs: 10_000,
    })).rejects.toMatchObject({ code: "OSINARA_INSTALL_GROQ_MODEL_UNAVAILABLE" });
  });

  it("rejects a matching id that is not a valid Groq model object", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ active: true, id: "whisper-large-v3-turbo", object: "model" }],
      object: "list",
    }), { status: 200 }));

    await expect(validateGroqVoiceCredential({
      apiKey: "groq-secret",
      fetch,
      timeoutMs: 10_000,
    })).rejects.toMatchObject({ code: "OSINARA_INSTALL_GROQ_VALIDATION_FAILED" });
  });

  it("returns a safe diagnostic for request failures", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("authorization details"));

    await expect(validateGroqVoiceCredential({
      apiKey: "groq-secret",
      fetch,
      timeoutMs: 10_000,
    })).rejects.toMatchObject({
      code: "OSINARA_INSTALL_GROQ_VALIDATION_FAILED",
      message: expect.not.stringContaining("groq-secret"),
    });
  });
});
