/** OpenRouter's dedicated Image API. One billable request, bounded raster response, no retries. */
import { fileTypeFromBuffer } from 'file-type';
import { AppError } from '../app-error.js';
import type { GeneratedImage, ImageGenerationRequest, ImageMediaType } from './image-generation-client.js';

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;
const RASTER_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

function unknownOutcome(): AppError {
  return new AppError('AGENT_IMAGE_GENERATION_STATUS_UNKNOWN',
    'OpenRouter не подтвердил результат генерации. Запрос мог быть оплачен; автоматически не повторяйте его');
}

async function readBody(response: Response): Promise<string> {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES || !response.body) throw unknownOutcome();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw unknownOutcome();
    }
    chunks.push(part.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createOpenRouterImageClient(options: {apiKey: string; model: string; fetch?: typeof fetch}) {
  const assertConfigured = () => {
    if (!options.apiKey || /\s/u.test(options.apiKey) || !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._:-]+$/u.test(options.model)) {
      throw new AppError('AGENT_IMAGE_GENERATION_CONFIG_INVALID', 'Для OpenRouter нужны ключ и точное имя модели изображений');
    }
  };
  return {
    assertConfigured,
    async generate(input: ImageGenerationRequest): Promise<GeneratedImage> {
      assertConfigured();
      let response: Response;
      try {
        response = await (options.fetch ?? globalThis.fetch)('https://openrouter.ai/api/v1/images', {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5 * 60 * 1000),
          headers: {authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json'},
          body: JSON.stringify({model: options.model, prompt: input.prompt, n: 1,
            ...(input.references?.length ? {input_references: input.references.map(reference => ({
              type: 'image_url', image_url: {url: `data:${reference.mediaType};base64,${reference.bytes.toString('base64')}`},
            }))} : {}),
            aspect_ratio: input.size === '1536x1024' ? '3:2' : input.size === '1024x1536' ? '2:3' : '1:1',
            ...(input.quality !== 'auto' ? {quality: input.quality} : {}),
            ...(input.background !== 'auto' ? {background: input.background} : {}),
          }),
        });
      } catch { throw unknownOutcome(); }
      if (response.status >= 400 && response.status < 500) {
        throw new AppError('AGENT_IMAGE_GENERATION_REJECTED',
          `OpenRouter отклонил генерацию (HTTP ${response.status}). Проверьте баланс, доступ к модели и параметры запроса`);
      }
      if (!response.ok) throw unknownOutcome();
      try {
        const payload = JSON.parse(await readBody(response));
        const items = payload?.data;
        if (!Array.isArray(items) || items.length !== 1) throw unknownOutcome();
        const encoded = items[0]?.b64_json;
        if (typeof encoded !== 'string' || !encoded || encoded.length % 4 !== 0 || !BASE64.test(encoded)) throw unknownOutcome();
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.toString('base64') !== encoded) throw unknownOutcome();
        const detected = await fileTypeFromBuffer(bytes);
        if (!detected || !RASTER_TYPES.has(detected.mime) ||
          (items[0].media_type && items[0].media_type !== detected.mime)) throw unknownOutcome();
        return {bytes, mediaType: detected.mime as ImageMediaType, model: options.model};
      } catch { throw unknownOutcome(); }
    },
  };
}
