/**
 * Flux image generation providers with an ordered fallback chain.
 *
 * Exports:
 * - `createCloudflareImageClient`: Workers AI text-to-image (FLUX.2 klein-4b only).
 * - `createNeuralDeepImageClient`: async task API (create → poll → download PNG).
 * - `createFallbackImageClient`: advances after definitive refusals; unknown outcomes stop the chain.
 * - `detectImageMediaType`: PNG / JPEG / WebP by magic bytes; anything else is rejected.
 */
import { AppError, isAppError } from "../app-error.js";
import type { GeneratedImage, ImageGenerationRequest, ImageMediaType } from "./image-generation-client.js";

// klein-9b and flux-2-dev are deliberately absent: they burn the free Workers AI quota in a few images.
// flux-1-schnell is absent too: it rejects width/height, so it cannot honour the requested size.
export const CLOUDFLARE_IMAGE_MODELS = ["@cf/black-forest-labs/flux-2-klein-4b"] as const;
type CloudflareImageModel = (typeof CLOUDFLARE_IMAGE_MODELS)[number];

/** FLUX.2 models accept only multipart bodies. */
function cloudflareRequestBody(fields: Record<string, string>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return form;
}
export const NEURALDEEP_IMAGE_BASE_URL = "https://api.neuraldeep.ru/v1";
const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";
const GENERATION_TIMEOUT_MS = 3 * 60 * 1_000;
const NEURALDEEP_POLL_INTERVAL_MS = 3_000;
const NEURALDEEP_POLL_TIMEOUT_MS = 4 * 60 * 1_000;
const MAX_IMAGE_BYTES = 32 * 1_024 * 1_024;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u;

export interface FluxImageClient {
  assertConfigured(): void;
  generate(input: ImageGenerationRequest): Promise<GeneratedImage>;
  readonly name: string;
}

interface FetchDependencies {
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

export function detectImageMediaType(bytes: Uint8Array): ImageMediaType | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

/**
 * Codex sizes map to small Flux dimensions: Workers AI bills per 512x512 tile, so a square is one
 * tile and the landscape/portrait variants are two. NeuralDeep only takes an aspect ratio.
 */
function dimensions(size: ImageGenerationRequest["size"]): { aspectRatio: string; height: number; width: number } {
  switch (size) {
    case "1536x1024": return { aspectRatio: "3:2", height: 512, width: 768 };
    case "1024x1536": return { aspectRatio: "3:5", height: 768, width: 512 };
    default: return { aspectRatio: "1:1", height: 512, width: 512 };
  }
}

function unavailable(provider: string, detail: string): AppError {
  console.error(JSON.stringify({ code: "AGENT_IMAGE_GENERATION_PROVIDER_UNAVAILABLE", detail, provider }));
  return new AppError(
    "AGENT_IMAGE_GENERATION_PROVIDER_UNAVAILABLE",
    "Сервис генерации изображений сейчас недоступен",
  );
}

/** The provider may have produced (and billed) the image; never retry an unknown outcome elsewhere. */
function ambiguous(provider: string, detail: string): AppError {
  console.error(JSON.stringify({ code: "AGENT_IMAGE_GENERATION_AMBIGUOUS", detail, provider }));
  return new AppError(
    "AGENT_IMAGE_GENERATION_AMBIGUOUS",
    "Не удалось подтвердить результат генерации. Проверьте результат перед новым запросом",
  );
}

function rejected(provider: string, detail: string): AppError {
  console.error(JSON.stringify({ code: "AGENT_IMAGE_GENERATION_REJECTED", detail, provider }));
  return new AppError(
    "AGENT_IMAGE_GENERATION_REJECTED",
    "Сервис генерации изображений отклонил запрос. Уберите названия брендов, марок и персон, "
      + "опишите объект своими словами и попробуйте снова",
  );
}

function imageFromBytes(bytes: Buffer, model: string, provider: string): GeneratedImage {
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw ambiguous(provider, `image size ${bytes.length}`);
  const mediaType = detectImageMediaType(bytes);
  if (mediaType === null) throw ambiguous(provider, "unknown image format");
  return { bytes, mediaType, model };
}

/** Error codes from a Workers AI failure body, for the log line only; the body is never shown to the model. */
async function cloudflareErrorCodes(response: Response): Promise<string> {
  try {
    const payload = await response.json() as { errors?: readonly { code?: unknown }[] };
    return (payload.errors ?? []).map((entry) => String(entry.code ?? "?")).join(",");
  } catch {
    return "";
  }
}

/** Statuses after which trying another provider is safe: nothing was produced for this request. */
function isProviderUnavailableStatus(status: number): boolean {
  return status === 401 || status === 402 || status === 403 || status === 429;
}

function isAmbiguousStatus(status: number): boolean {
  return status === 408 || status >= 500;
}

export function createCloudflareImageClient(
  options: { accountId: string; token: string } & FetchDependencies,
): FluxImageClient {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  return {
    name: "cloudflare",
    assertConfigured() {
      if (!/^[0-9a-f]{32}$/u.test(options.accountId) || !options.token || /\s/u.test(options.token)) {
        throw new AppError("AGENT_IMAGE_GENERATION_CONFIG_INVALID", "Не настроен доступ к Cloudflare Workers AI");
      }
    },
    async generate(input) {
      this.assertConfigured();
      const { height, width } = dimensions(input.size);
      const model: CloudflareImageModel = CLOUDFLARE_IMAGE_MODELS[0];
      const url = `${CLOUDFLARE_API_BASE_URL}/accounts/${options.accountId}/ai/run/${model}`;
      const body = cloudflareRequestBody({
        height: String(height), prompt: input.prompt, steps: "4", width: String(width),
      });
      let response: Response;
      try {
        response = await fetchImplementation(url, {
          body,
          headers: { authorization: `Bearer ${options.token}` },
          method: "POST",
          signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
        });
      } catch (error) {
        throw ambiguous("cloudflare", error instanceof Error ? error.message : String(error));
      }
      if (!response.ok) {
        if (isAmbiguousStatus(response.status)) throw ambiguous("cloudflare", `create ${response.status}`);
        const detail = `${model} ${response.status} ${await cloudflareErrorCodes(response)}`.trim();
        if (isProviderUnavailableStatus(response.status)) throw unavailable("cloudflare", detail);
        // 400 covers both bad parameters and the content filter (code 3030); the chain decides what is next.
        throw rejected("cloudflare", detail);
      }
      // From here the request is accepted: a lost body is an unknown outcome, not a provider refusal.
      const contentType = response.headers.get("content-type") ?? "";
      let bytes: Buffer;
      try {
        if (contentType.includes("application/json")) {
          const payload = await response.json() as { result?: { image?: unknown }; success?: unknown };
          const encoded = payload.result?.image;
          if (typeof encoded !== "string" || encoded.length % 4 !== 0 || !BASE64_PATTERN.test(encoded)) {
            throw ambiguous("cloudflare", `${model} malformed image payload`);
          }
          bytes = Buffer.from(encoded, "base64");
        } else {
          bytes = Buffer.from(await response.arrayBuffer());
        }
      } catch (error) {
        if (isAppError(error)) throw error;
        throw ambiguous("cloudflare", error instanceof Error ? error.message : String(error));
      }
      return imageFromBytes(bytes, model, "cloudflare");
    },
  };
}

export function createNeuralDeepImageClient(
  options: { apiKey: string; baseUrl?: string; pollTimeoutMs?: number } & FetchDependencies,
): FluxImageClient {
  const pollTimeoutMs = options.pollTimeoutMs ?? NEURALDEEP_POLL_TIMEOUT_MS;
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const baseUrl = (options.baseUrl ?? NEURALDEEP_IMAGE_BASE_URL).replace(/\/$/u, "");
  const headers = { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" };
  return {
    name: "neuraldeep",
    assertConfigured() {
      if (!options.apiKey || /\s/u.test(options.apiKey)) {
        throw new AppError("AGENT_IMAGE_GENERATION_CONFIG_INVALID", "Не настроен доступ к NeuralDeep Image API");
      }
    },
    async generate(input) {
      this.assertConfigured();
      const { aspectRatio } = dimensions(input.size);
      let created: Response;
      try {
        created = await fetchImplementation(`${baseUrl}/images/generate`, {
          body: JSON.stringify({ options: { aspect_ratio: aspectRatio }, prompt: input.prompt }),
          headers,
          method: "POST",
          signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
        });
      } catch (error) {
        throw ambiguous("neuraldeep", error instanceof Error ? error.message : String(error));
      }
      if (!created.ok) {
        if (isAmbiguousStatus(created.status)) throw ambiguous("neuraldeep", `create ${created.status}`);
        throw isProviderUnavailableStatus(created.status)
          ? unavailable("neuraldeep", `create ${created.status}`)
          : rejected("neuraldeep", `create ${created.status}`);
      }
      let task: { task_uid?: unknown } | null;
      try {
        task = await created.json() as typeof task;
      } catch (error) {
        throw ambiguous("neuraldeep", error instanceof Error ? error.message : String(error));
      }
      if (typeof task?.task_uid !== "string" || !/^[0-9a-f-]{8,64}$/u.test(task.task_uid)) {
        throw ambiguous("neuraldeep", "task id missing");
      }
      // One deadline bounds every poll, the result download and the body read: a hanging GET used
      // to outlive the window because time was checked only after a response arrived.
      const deadline = Date.now() + pollTimeoutMs;
      const remaining = () => {
        const left = deadline - Date.now();
        if (left <= 0) throw ambiguous("neuraldeep", "poll timeout");
        return AbortSignal.timeout(left);
      };
      const bounded = async <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
        try {
          return await operation(remaining());
        } catch (error) {
          if (isAppError(error)) throw error;
          throw ambiguous("neuraldeep", error instanceof Error ? error.message : String(error));
        }
      };
      for (;;) {
        await sleep(NEURALDEEP_POLL_INTERVAL_MS);
        const status = await bounded((signal) => fetchImplementation(`${baseUrl}/images/tasks/${task.task_uid}`, { headers, method: "GET", signal }));
        if (!status.ok) throw ambiguous("neuraldeep", `status ${status.status}`);
        const state = (await bounded(() => status.json()) as { error?: unknown; status?: unknown }).status;
        if (state === "finished") break;
        if (state === "failed" || state === "error") throw rejected("neuraldeep", "task failed");
        remaining();
      }
      const result = await bounded((signal) => fetchImplementation(`${baseUrl}/images/tasks/${task.task_uid}/result`, { headers, method: "GET", signal }));
      if (!result.ok) throw ambiguous("neuraldeep", `result ${result.status}`);
      return imageFromBytes(Buffer.from(await bounded(() => result.arrayBuffer())), "neuraldeep/flux", "neuraldeep");
    },
  };
}

export function createFallbackImageClient(clients: readonly FluxImageClient[]): FluxImageClient {
  if (clients.length === 0) {
    throw new AppError("AGENT_IMAGE_GENERATION_CONFIG_INVALID", "Не настроен ни один сервис генерации изображений");
  }
  return {
    name: clients.map((client) => client.name).join(">"),
    assertConfigured() {
      for (const client of clients) client.assertConfigured();
    },
    async generate(input) {
      let lastError: unknown = null;
      for (const client of clients) {
        try {
          return await client.generate(input);
        } catch (error) {
          // An accepted request with an unknown outcome must not be repeated elsewhere: the image
          // may already exist and be billed. Refusals and outages move on to the next provider.
          if (!isAppError(error)) {
            throw ambiguous(client.name, error instanceof Error ? error.message : String(error));
          }
          if (error.code !== "AGENT_IMAGE_GENERATION_REJECTED" &&
            error.code !== "AGENT_IMAGE_GENERATION_PROVIDER_UNAVAILABLE") throw error;
          // Content filters and parameter rules differ per provider, so even a rejection moves on.
          lastError = error;
          console.error(JSON.stringify({
            code: "AGENT_IMAGE_GENERATION_FALLBACK",
            from: client.name,
            reason: isAppError(error) ? error.code : "unknown",
          }));
        }
      }
      throw lastError instanceof Error ? lastError : unavailable("chain", "all providers failed");
    },
  };
}
