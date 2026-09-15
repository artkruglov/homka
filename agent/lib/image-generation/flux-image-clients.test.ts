/**
 * Flux provider chain tests.
 *
 * Constructs covered:
 * - Cloudflare klein-4b takes a multipart body; the media type comes from magic bytes, not from the provider.
 * - Definitive Cloudflare refusals fall through to NeuralDeep; unknown outcomes stop the chain.
 *   Schnell is never tried because it neither accepts dimensions nor a cheaper quality.
 * - When every provider rejects the prompt the chain reports a rejection, not an outage.
 * - NeuralDeep creates a task, polls until finished and downloads the PNG result.
 */
import { describe, expect, it, vi } from "vitest";

import {
  CLOUDFLARE_IMAGE_MODELS,
  createCloudflareImageClient,
  createFallbackImageClient,
  createNeuralDeepImageClient,
  detectImageMediaType,
} from "./flux-image-clients.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const request = { background: "auto" as const, prompt: "кот на подоконнике", quality: "auto" as const, size: "1024x1024" as const };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

function neuralDeepSuccess() {
  return vi.fn()
    .mockResolvedValueOnce(json({ task_uid: "1ca2c888-1a64-4fbe-99e9-23c230779a37" }))
    .mockResolvedValueOnce(json({ status: "queued" }))
    .mockResolvedValueOnce(json({ status: "finished" }))
    .mockResolvedValueOnce(new Response(PNG, { headers: { "content-type": "image/png" }, status: 200 }));
}

describe("flux image clients", () => {
  it.each(["network", "server", "request-timeout", "invalid-json", "invalid-base64", "invalid-image"])(
    "does not fall back after an ambiguous Cloudflare %s result", async (failure) => {
      const cloudflareFetch = vi.fn(async () => {
        if (failure === "network") throw new TypeError("fetch failed after POST");
        if (failure === "server") return json({}, 503);
        if (failure === "request-timeout") return json({}, 408);
        if (failure === "invalid-json") return new Response("{", { headers: { "content-type": "application/json" } });
        if (failure === "invalid-base64") return json({ success: true, result: { image: "invalid base64" } });
        return new Response("not an image", { headers: { "content-type": "image/png" } });
      });
      const neuralFetch = neuralDeepSuccess();
      const chain = createFallbackImageClient([
        createCloudflareImageClient({ accountId: "0".repeat(32), fetch: cloudflareFetch, token: "test" }),
        createNeuralDeepImageClient({ apiKey: "test", fetch: neuralFetch, sleep: async () => {} }),
      ]);
      await expect(chain.generate(request)).rejects.toMatchObject({ code: "AGENT_IMAGE_GENERATION_AMBIGUOUS" });
      expect(neuralFetch).not.toHaveBeenCalled();
    },
  );

  it.each(["network", "server", "task-json", "task-id", "poll", "download"])(
    "keeps an ambiguous NeuralDeep %s result terminal", async (failure) => {
      const fetch = vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith("/generate")) {
          if (failure === "network") throw new TypeError("fetch failed after POST");
          if (failure === "server") return json({}, 500);
          if (failure === "task-json") return new Response("{");
          if (failure === "task-id") return json({});
          return json({ task_uid: "1ca2c888-1a64-4fbe-99e9-23c230779a37" });
        }
        if (failure === "poll" || String(url).endsWith("/result")) throw new TypeError("socket hang up");
        return json({ status: "finished" });
      });
      const generate = vi.fn().mockResolvedValue({ bytes: PNG, mediaType: "image/png", model: "next" });
      const chain = createFallbackImageClient([
        createNeuralDeepImageClient({ apiKey: "test", fetch, sleep: async () => {} }),
        { name: "next", assertConfigured() {}, generate },
      ]);
      await expect(chain.generate(request)).rejects.toMatchObject({ code: "AGENT_IMAGE_GENERATION_AMBIGUOUS" });
      expect(generate).not.toHaveBeenCalled();
    },
  );
  it("detects image formats by magic bytes", () => {
    expect(detectImageMediaType(PNG)).toBe("image/png");
    expect(detectImageMediaType(JPEG)).toBe("image/jpeg");
    expect(detectImageMediaType(Buffer.from("hello"))).toBeNull();
  });

  it("offers only klein-4b on Cloudflare", () => {
    expect(CLOUDFLARE_IMAGE_MODELS).toEqual(["@cf/black-forest-labs/flux-2-klein-4b"]);
  });

  it("generates through Cloudflare klein-4b and derives the media type from bytes", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ result: { image: JPEG.toString("base64") }, success: true }));
    const client = createCloudflareImageClient({ accountId: "0".repeat(32), fetch: fetch as never, token: "cf-token" });

    const image = await client.generate({ ...request, quality: "low" });

    expect(image).toMatchObject({ mediaType: "image/jpeg", model: "@cf/black-forest-labs/flux-2-klein-4b" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toContain("/ai/run/@cf/black-forest-labs/flux-2-klein-4b");
    // FLUX.2 takes multipart form fields, not JSON.
    expect(init.body).toBeInstanceOf(FormData);
    expect(Object.fromEntries((init.body as FormData).entries())).toEqual({ height: "512", prompt: "кот на подоконнике", steps: "4", width: "512" });
    expect(init.headers["content-type"]).toBeUndefined();
  });

  it("falls back from an exhausted Cloudflare quota to NeuralDeep", async () => {
    const cloudflareFetch = vi.fn().mockResolvedValue(json({ errors: [{ code: 3040, message: "quota" }] }, 429));
    const neuralFetch = neuralDeepSuccess();
    const chain = createFallbackImageClient([
      createCloudflareImageClient({ accountId: "0".repeat(32), fetch: cloudflareFetch as never, token: "cf-token" }),
      createNeuralDeepImageClient({ apiKey: "nd-key", fetch: neuralFetch as never, sleep: async () => {} }),
    ]);

    const image = await chain.generate({ ...request, size: "1536x1024" });

    expect(image).toMatchObject({ mediaType: "image/png", model: "neuraldeep/flux" });
    expect(cloudflareFetch).toHaveBeenCalledTimes(1);
    expect(Object.fromEntries((cloudflareFetch.mock.calls[0]![1].body as FormData).entries())).toMatchObject({ height: "512", width: "768" });
    expect(JSON.parse(neuralFetch.mock.calls[0]![1].body)).toEqual({ options: { aspect_ratio: "3:2" }, prompt: "кот на подоконнике" });
    expect(String(neuralFetch.mock.calls[3]![0])).toContain("/images/tasks/1ca2c888-1a64-4fbe-99e9-23c230779a37/result");
  });

  it("falls back to NeuralDeep when the Cloudflare content filter flags the prompt", async () => {
    const cloudflareFetch = vi.fn().mockResolvedValue(json({ errors: [{ code: 3030, message: "Your output has been flagged" }] }, 400));
    const neuralFetch = neuralDeepSuccess();
    const chain = createFallbackImageClient([
      createCloudflareImageClient({ accountId: "0".repeat(32), fetch: cloudflareFetch as never, token: "cf-token" }),
      createNeuralDeepImageClient({ apiKey: "nd-key", fetch: neuralFetch as never, sleep: async () => {} }),
    ]);

    const image = await chain.generate({ ...request, prompt: "Porsche Cayman на дороге" });

    expect(image).toMatchObject({ mediaType: "image/png", model: "neuraldeep/flux" });
    expect(neuralFetch).toHaveBeenCalledTimes(4);
  });

  it("does not try the next provider when Cloudflare accepted the request but the body was lost", async () => {
    const cloudflareFetch = vi.fn().mockResolvedValue({
      arrayBuffer: () => Promise.reject(new Error("socket hang up")),
      headers: new Headers({ "content-type": "image/png" }),
      ok: true,
      status: 200,
    } as unknown as Response);
    const neuralFetch = neuralDeepSuccess();
    const chain = createFallbackImageClient([
      createCloudflareImageClient({ accountId: "0".repeat(32), fetch: cloudflareFetch as never, token: "cf-token" }),
      createNeuralDeepImageClient({ apiKey: "nd-key", fetch: neuralFetch as never, sleep: async () => {} }),
    ]);

    // The image may have been produced and billed; a second provider would double it.
    await expect(chain.generate(request)).rejects.toMatchObject({ code: "AGENT_IMAGE_GENERATION_AMBIGUOUS" });
    expect(neuralFetch).not.toHaveBeenCalled();
  });

  it("bounds NeuralDeep polling and download by one deadline", async () => {
    const hangingFetch = vi.fn()
      .mockResolvedValueOnce(json({ task_uid: "1ca2c888-1a64-4fbe-99e9-23c230779a37" }))
      .mockImplementation((_url: string, init: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }));
    const client = createNeuralDeepImageClient({ apiKey: "nd-key", fetch: hangingFetch as never, pollTimeoutMs: 80, sleep: async () => {} });

    const started = Date.now();
    await expect(client.generate(request)).rejects.toMatchObject({ code: "AGENT_IMAGE_GENERATION_AMBIGUOUS" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("reports a rejection with a wording hint when every provider refuses the prompt", async () => {
    const cloudflareFetch = vi.fn().mockResolvedValue(json({ errors: [{ code: 3030, message: "flagged" }] }, 400));
    const neuralFetch = vi.fn().mockResolvedValue(json({ error: "bad prompt" }, 422));
    const chain = createFallbackImageClient([
      createCloudflareImageClient({ accountId: "0".repeat(32), fetch: cloudflareFetch as never, token: "cf-token" }),
      createNeuralDeepImageClient({ apiKey: "nd-key", fetch: neuralFetch as never }),
    ]);

    await expect(chain.generate(request)).rejects.toMatchObject({
      code: "AGENT_IMAGE_GENERATION_REJECTED",
      message: expect.stringContaining("брендов"),
    });
    expect(neuralFetch).toHaveBeenCalledTimes(1);
  });
});
