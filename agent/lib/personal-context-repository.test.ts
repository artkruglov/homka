/** Telegram's current member response is authoritative; missing/ambiguous results deny access. */
import { afterEach, describe, expect, it, vi } from "vitest";
const api=vi.hoisted(()=>vi.fn());
vi.mock('eve/channels/telegram',()=>({callTelegramApi:api}));
import { isCurrentTelegramMember } from "./telegram-current-membership.js";
afterEach(()=>vi.resetAllMocks());
describe('current Telegram membership',()=>{
  it.each(['creator','administrator','member'])('accepts a verified %s',async(status)=>{
    api.mockResolvedValue({ok:true,body:{ok:true,result:{status,user:{id:123,is_bot:false}}}});
    expect(await isCurrentTelegramMember('-1','123')).toBe(true);
    expect(api.mock.calls[0]?.[0]).toMatchObject({method:'getChatMember',body:{chat_id:'-1',user_id:123}});
  });
  it.each([
    {status:'left',user:{id:123,is_bot:false}},
    {status:'kicked',user:{id:123,is_bot:false}},
    {status:'restricted',is_member:false,user:{id:123,is_bot:false}},
    {status:'administrator',user:{id:456,is_bot:false}},
    {status:'member',user:{id:123,is_bot:true}},
    {status:'unknown',user:{id:123,is_bot:false}},
  ])('denies absent, mismatched, bot and malformed membership',async(result)=>{
    api.mockResolvedValue({ok:true,body:{ok:true,result}});
    expect(await isCurrentTelegramMember('-1','123')).toBe(false);
  });
  it('denies network failures and does not retry',async()=>{
    api.mockRejectedValue(Error('timeout'));
    expect(await isCurrentTelegramMember('-1','123')).toBe(false);
    expect(api).toHaveBeenCalledTimes(1);
  });
});
