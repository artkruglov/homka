/** OpenRouter asynchronous video API: one submission, recoverable polling, fixed-origin downloads. */
import { fileTypeFromBuffer } from 'file-type';
import { AppError } from '../app-error.js';
import {quoteSeedanceVideo,usdToMicros} from './video-pricing.js';

export const VIDEO_MODELS = ['bytedance/seedance-2.5', 'minimax/hailuo-3-max', 'alibaba/wan-3.0-prime'] as const;
export interface VideoRequest {
  model: typeof VIDEO_MODELS[number];
  prompt: string;
  duration: number;
  resolution: string;
  aspectRatio: string;
  size?: string;
  firstFrame?: {bytes:Buffer;mediaType:'image/png'|'image/jpeg'|'image/webp'};
}
const API = 'https://openrouter.ai/api/v1/videos';
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
function error(code: string, message: string) { return new AppError(`AGENT_VIDEO_${code}`, message); }
function unknown() {
  return error('STATUS_UNKNOWN', 'OpenRouter не подтвердил номер видеозадания. Запрос мог быть оплачен; автоматически не повторяйте генерацию');
}
function requireJobId(id: string): void {
  if (!/^[A-Za-z0-9_-]{1,200}$/u.test(id)) throw error('JOB_INVALID', 'Некорректный номер видеозадания');
}
async function boundedBytes(response: Response, max: number, failure: () => AppError): Promise<Buffer> {
  if (!response.body || Number(response.headers.get('content-length')) > max) throw failure();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > max) { await reader.cancel(); throw failure(); }
    chunks.push(part.value);
  }
  return Buffer.concat(chunks);
}
async function readJson(response: Response) {
  return JSON.parse((await boundedBytes(response, 2*1024*1024,
    () => error('RESPONSE_INVALID', 'Сервис видео вернул некорректный ответ'))).toString('utf8'));
}

export function createOpenRouterVideoClient(options: {apiKey: string; fetch?: typeof fetch}) {
  const assertConfigured = () => {
    if (!options.apiKey || /\s/u.test(options.apiKey)) {
      throw error('CONFIG_INVALID', 'Для генерации видео нужен отдельный OPENROUTER_VIDEO_API_KEY');
    }
  };
  const request = async (path: string, init: RequestInit = {}) => {
    assertConfigured();
    return await (options.fetch ?? globalThis.fetch)(`${API}${path}`, {
      ...init, redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: {authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json'},
    });
  };
  const inspectStatus=async(jobId:string):Promise<{status:'pending'|'completed'|'failed';actualCostMicros?:number}>=>{
    requireJobId(jobId);
    try {
      const response=await request(`/${jobId}`);
      if(!response.ok)throw new Error();
      const payload=await readJson(response);
      if(payload?.id!==jobId)throw new Error();
      const state=payload.status;
      const status=state==='completed'?'completed':['failed','cancelled','expired'].includes(state)?'failed':
        ['pending','processing','queued','running','in_progress'].includes(state)?'pending':null;
      if(!status)throw new Error();
      const cost=payload.usage?.cost;
      if(cost!==undefined && cost!==null && typeof cost!=='number')throw new Error();
      return {status,...(cost===undefined||cost===null?{}:{actualCostMicros:usdToMicros(cost)})};
    }catch{
      throw error('POLL_FAILED','Статус видео временно недоступен. Проверьте сохранённое задание без новой генерации');
    }
  };
  return {
    assertConfigured,
    async quote(input:VideoRequest) {
      let payload;
      try {
        const response=await request('/models');
        if(!response.ok)throw new Error();
        payload=await readJson(response);
      }catch{throw error('CATALOG_UNAVAILABLE','Не удалось проверить тариф видео. Генерация ещё не заказана');}
      const model=Array.isArray(payload?.data)?payload.data.find((m:{id?:string})=>m.id===input.model):null;
      return quoteSeedanceVideo(model,{size:input.size??'',duration:input.duration,firstFrame:!!input.firstFrame});
    },
    async validate(input: VideoRequest): Promise<void> {
      assertConfigured();
      if (!VIDEO_MODELS.includes(input.model)) throw error('PARAMETERS_UNSUPPORTED', 'Эта видеомодель не подключена');
      let payload;
      try {
        const response = await request('/models');
        if (!response.ok) throw new Error();
        payload = await readJson(response);
      } catch {
        throw error('CATALOG_UNAVAILABLE', 'Не удалось проверить параметры видеомодели. Генерация ещё не заказана');
      }
      const model = Array.isArray(payload?.data) ? payload.data.find((item: {id?:string}) => item.id === input.model) : null;
      if (!model || !Array.isArray(model.supported_durations) || !model.supported_durations.includes(input.duration) ||
          !Array.isArray(model.supported_resolutions) || !model.supported_resolutions.includes(input.resolution) ||
          !Array.isArray(model.supported_aspect_ratios) || !model.supported_aspect_ratios.includes(input.aspectRatio)) {
        throw error('PARAMETERS_UNSUPPORTED', 'Модель не поддерживает выбранные длительность, размер или пропорции. Генерация ещё не заказана');
      }
    },
    async submit(input: VideoRequest): Promise<{jobId: string}> {
      assertConfigured();
      let response;
      try {
        response = await request('', {method:'POST',body:JSON.stringify({
          model:input.model, prompt:input.prompt, duration:input.duration,
          ...(input.size?{size:input.size}:{resolution:input.resolution, aspect_ratio:input.aspectRatio}),
          ...(input.firstFrame?{frame_images:[{type:'image_url',frame_type:'first_frame',
            image_url:{url:`data:${input.firstFrame.mediaType};base64,${input.firstFrame.bytes.toString('base64')}`}}]}:{}),
        })});
      } catch { throw unknown(); }
      if ([400,401,402,403,404,422,429].includes(response.status)) {
        throw error('REJECTED', `OpenRouter отклонил видеозадание (HTTP ${response.status}). Проверьте баланс и доступ к модели`);
      }
      if (!response.ok) throw unknown();
      try {
        const payload = await readJson(response);
        if (typeof payload?.id !== 'string') throw unknown();
        requireJobId(payload.id);
        // A provider-returned polling URL is data, never a destination for our bearer token.
        return {jobId: payload.id};
      } catch { throw unknown(); }
    },
    inspectStatus,
    async status(jobId:string):Promise<'pending'|'completed'|'failed'>{
      return (await inspectStatus(jobId)).status;
    },
    async download(jobId: string): Promise<Buffer> {
      requireJobId(jobId);
      let response;
      try { response = await request(`/${jobId}/content?index=0`); }
      catch { throw error('DOWNLOAD_FAILED', 'Не удалось скачать готовое видео. Повторите проверку этого задания'); }
      if (!response.ok) throw error('DOWNLOAD_FAILED', 'Сервис пока не отдал готовое видео. Повторите проверку этого задания');
      const bytes = await boundedBytes(response,MAX_VIDEO_BYTES,
        () => error('CONTENT_TOO_LARGE', 'Видео превышает лимит Telegram 50 МБ'));
      let detected;
      try { detected = await fileTypeFromBuffer(bytes); } catch { /* malformed bytes fail below */ }
      if (detected?.mime !== 'video/mp4') throw error('CONTENT_INVALID', 'Сервис не вернул корректный MP4. Повторите проверку этого задания');
      return bytes;
    },
  };
}
