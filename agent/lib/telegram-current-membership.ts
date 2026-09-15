/** Current Telegram membership through the existing Eve transport, fail closed on any uncertainty. */
import { callTelegramApi } from "eve/channels/telegram";
import { z } from "zod";

const memberResponse=z.object({ok:z.literal(true),result:z.object({
  status:z.enum(['creator','administrator','member','restricted','left','kicked']),
  is_member:z.boolean().optional(),user:z.object({id:z.number().int().positive(),is_bot:z.literal(false)})
})});

export async function isCurrentTelegramMember(chatId:string,telegramUserId:string):Promise<boolean> {
  if (!/^-[1-9]\d*$/.test(chatId) || !/^[1-9]\d*$/.test(telegramUserId) || !Number.isSafeInteger(Number(telegramUserId))) return false;
  try {
    const response=await callTelegramApi({method:'getChatMember',body:{chat_id:chatId,user_id:Number(telegramUserId)},
      fetch:(url,init)=>fetch(url,{...init,signal:AbortSignal.timeout(10_000)})});
    if (!response.ok) return false;
    const parsed=memberResponse.safeParse(response.body);
    if (!parsed.success || String(parsed.data.result.user.id)!==telegramUserId) return false;
    const member=parsed.data.result;
    return ['creator','administrator','member'].includes(member.status) || member.status==='restricted' && member.is_member===true;
  } catch { return false; }
}
