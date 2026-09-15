/** Private context search must prove current membership before exposing group content. */
import { describe, expect, it, vi } from "vitest";
import { searchPersonalContexts, type PersonalContextDependencies } from "./personal-context-search.js";
import type { MemoryAuthorization } from "./memory-context.js";
const auth: MemoryAuthorization = { familyId:'family',userId:'user',groupId:null,role:'member',
  scopes:['personal','family'],telegramActorKind:'telegram_user',telegramActorId:'123',telegramUserId:'123' };
function dependencies() {
  return { assertPrivate:vi.fn(async()=>{}), groups:vi.fn(async()=>[{id:'g1',title:'One',chatId:'-1'}]),
    member:vi.fn(async()=>true), stillAllowed:vi.fn(async()=>true),
    search:vi.fn<PersonalContextDependencies['search']>(async()=>[]) } satisfies PersonalContextDependencies;
}
describe('personal context search',()=>{
  it('never exposes group content when Telegram membership cannot be proven',async()=>{
    const d=dependencies(); d.member.mockResolvedValue(false);
    const result=await searchPersonalContexts(auth,{action:'search',query:'hello'},d);
    expect(result.contexts).toHaveLength(1);
    expect(d.search).toHaveBeenCalledTimes(1);
    expect(d.search.mock.calls[0]?.[0]).toMatchObject({groupId:null});
  });
  it('uses a group-only backend scope and does not mutate private authorization',async()=>{
    const d=dependencies();
    const result=await searchPersonalContexts(auth,{action:'search',query:'hello'},d);
    expect(result.contexts).toHaveLength(2);
    expect(d.search.mock.calls[1]?.[0]).toMatchObject({groupId:'g1',scopes:['group']});
    expect(auth.groupId).toBeNull();
  });
  it('discards results if registration or membership is revoked during retrieval',async()=>{
    const d=dependencies(); d.stillAllowed.mockResolvedValue(false);
    expect((await searchPersonalContexts(auth,{action:'search',query:'hello'},d)).contexts).toHaveLength(1);
  });
  it('rejects calls from groups before touching any data',async()=>{
    const d=dependencies();
    await expect(searchPersonalContexts({...auth,groupId:'group'}, {action:'list'},d)).rejects.toThrow();
    expect(d.groups).not.toHaveBeenCalled();
  });
});
