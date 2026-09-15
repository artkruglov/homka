/** Start a paid video once, or resume its scoped durable operation without resubmission. */
import {defineTool,type ToolContext} from 'eve/tools';
import {z} from 'zod';
import {AppError,isAppError} from '../app-error.js';
import {createVideoToolRuntime} from '../video-generation/video-tool-runtime.js';

export const videoInput=z.discriminatedUnion('action',[
  z.object({action:z.literal('start'),prompt:z.string().trim().min(1).max(8000),
    duration:z.number().int().min(4).max(30).default(5),
    size:z.enum(['1280x720','720x1280','960x960','854x480','480x854','640x640']).default('1280x720'),
    referencePath:z.string().min(1).max(500).optional(),referenceAttachmentId:z.string().uuid().optional()}).strict(),
  z.object({action:z.literal('status'),jobRef:z.string().min(1).max(500)}).strict(),
  z.object({action:z.literal('cancel_delivery'),jobRef:z.string().min(1).max(500)}).strict(),
  z.object({action:z.literal('budget')}).strict(),
  z.object({action:z.literal('list')}).strict(),
]).refine(input=>input.action!=='start'||!(input.referencePath&&input.referenceAttachmentId),
  {message:'Передайте один исходник: referencePath либо referenceAttachmentId'});

export function createGenerateVideoTool(runtime:(ctx:ToolContext)=>ReturnType<typeof createVideoToolRuntime>=createVideoToolRuntime){
  return defineTool({
    description:[
      'Создать видео Seedance 2.5 по явной просьбе человека или оживить фотографию. start: prompt описывает движение, камеру и сохраняемые детали; referencePath относительный путь к фото текущей области либо referenceAttachmentId фото текущего чата.',
      'По умолчанию 5 секунд 1280x720; стоимость проверяется по каталогу, лимит $30 на человека в месяц общий во всех чатах. budget возвращает использованный и оставшийся бюджет в миллионных долях доллара.',
      'pending означает, что заказ уже принят: сохрани operationKey как jobRef и сообщи, что готовый ролик придёт автоматически. status можно вызвать по просьбе человека; дополнительный запрос не обязателен. Не вызывай start повторно.',
      'status возвращает completed после сохранения MP4 и попытки доставки файла в текущий чат; проверь delivery.delivered. Готовый ролик отправляется файлом. Не отправляй второй раз самостоятельно.',
      'requestedParameters описывает заказ, не свойства готового файла. outputMedia.verification=not_measured означает, что размеры и длительность MP4 не измерены: не называй их фактическими и не обещай точное совпадение с заказом. При оживлении фото пропорции результата могут отличаться от запроса. Не заказывай замену автоматически.',
      'list показывает последние 20 своих заданий текущего чата или темы. Если после отмены или перезапуска нет jobRef, сначала вызови list, затем status выбранного задания. Не запускай замену через start.',
      'cancel_delivery по явной просьбе автора прекращает будущую автоматическую доставку своего заказа. Это не отмена оплаты и не возврат денег; уже начавшуюся отправку отозвать нельзя. Простая отмена ожидания в чате не прекращает автодоставку.',
      'При STATUS_UNKNOWN возможна оплата: не запускай новую генерацию без явной новой просьбы. При POLL_FAILED или DOWNLOAD_FAILED можно повторить только status того же задания. Нельзя переносить чужие задания между людьми и чатами.',
    ].join(' '),
    inputSchema:videoInput,
    async execute(raw,ctx){
      const parsed=videoInput.safeParse(raw);
      if(!parsed.success)throw new AppError('AGENT_VIDEO_INPUT_INVALID','Не удалось проверить параметры видео');
      const input=parsed.data;const bound=runtime(ctx);
      if(input.action==='list')return bound.list();
      if(input.action==='budget')return bound.balance();
      if(input.action==='cancel_delivery')return bound.cancelDelivery(input.jobRef);
      const operationKey=input.action==='status'?input.jobRef:ctx.callId;
      try {
        const result=input.action==='status'?await bound.resume(input.jobRef):await bound.start({...input,operationKey});
        return {...result,
          ...(input.action==='start'?{requestedParameters:{durationSeconds:input.duration,size:input.size}}:{}),
          // Neither the submitted size nor a provider status proves the MP4 stream geometry.
          // Keep this explicit on replay/status too; no second paid request is needed.
          ...(result.status==='completed'?{outputMedia:{verification:'not_measured' as const,
            width:null,height:null,durationSeconds:null}}:{}),
        };
      }catch(error){
        if(isAppError(error)&&['AGENT_VIDEO_POLL_FAILED','AGENT_VIDEO_DOWNLOAD_FAILED'].includes(error.code)){
          return {status:'pending' as const,operationKey,retryAfterSeconds:30,diagnosticCode:error.code};
        }
        throw error;
      }
    },
  });
}
export default createGenerateVideoTool();
