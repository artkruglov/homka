/** Backend-owned Seedance pricing; never accept a price from the conversational model. */
import {z} from 'zod';
import {AppError} from '../app-error.js';

export const VIDEO_MONTHLY_LIMIT_MICROS=30_000_000;
export const SEEDANCE_MODEL='bytedance/seedance-2.5';
const catalogModel=z.object({id:z.literal(SEEDANCE_MODEL),
  supported_sizes:z.array(z.string()),supported_durations:z.array(z.number().int()),
  supported_frame_images:z.array(z.string()).nullable().optional(),
  pricing_skus:z.object({video_tokens:z.string().regex(/^\d+\.\d{1,12}$/u)}),
});

export function videoBudgetMonth(now:Date):string {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit'}).formatToParts(now);
  return `${parts.find(p=>p.type==='year')!.value}-${parts.find(p=>p.type==='month')!.value}`;
}

export function usdToMicros(usd:number):number {
  const amount=Math.ceil(usd*1_000_000);
  if(!Number.isFinite(usd)||usd<0||!Number.isSafeInteger(amount)) {
    throw new AppError('AGENT_VIDEO_COST_INVALID','Сервис не подтвердил корректную стоимость видео');
  }
  return amount;
}

/** Reserve the endpoint frame too: the 2026-09-13 live charge exceeded the duration-only estimate. */
export function quoteSeedanceVideo(raw:unknown,input:{size:string;duration:number;firstFrame:boolean}) {
  const parsed=catalogModel.safeParse(raw);
  if(!parsed.success)throw new AppError('AGENT_VIDEO_PRICING_UNAVAILABLE','Не удалось проверить тариф Seedance 2.5. Видео ещё не заказано');
  const m=parsed.data;
  const size=/^(\d{3,4})x(\d{3,4})$/u.exec(input.size);
  if(!size||!m.supported_sizes.includes(input.size)||!m.supported_durations.includes(input.duration)||
    !Number.isInteger(input.duration)||input.duration<4||input.duration>30||
    input.firstFrame&&!m.supported_frame_images?.includes('first_frame')) {
    throw new AppError('AGENT_VIDEO_PARAMETERS_UNSUPPORTED','Seedance не поддерживает выбранный формат или исходное фото');
  }
  const [whole,fraction]=m.pricing_skus.video_tokens.split('.') as [string,string];
  const scale=10n**BigInt(fraction.length);
  const rate=BigInt(whole)*scale+BigInt(fraction);
  const numerator=BigInt(size[1]!)*BigInt(size[2]!)*(24n*BigInt(input.duration)+1n)*rate*1_000_000n;
  const denominator=1024n*scale;
  const reservedMicros=Number((numerator+denominator-1n)/denominator);
  if(rate<=0n||!Number.isSafeInteger(reservedMicros)||reservedMicros<=0||reservedMicros>VIDEO_MONTHLY_LIMIT_MICROS) {
    throw new AppError('AGENT_VIDEO_PRICING_UNAVAILABLE','Цена видео не подтверждена или превышает месячный предел');
  }
  return {model:SEEDANCE_MODEL,size:input.size,duration:input.duration,reservedMicros,
    pricePerTokenUsd:m.pricing_skus.video_tokens,quotedAt:new Date().toISOString()};
}
