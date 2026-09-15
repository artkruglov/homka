import {describe,expect,it,vi} from 'vitest';
import type {ToolContext} from 'eve/tools';
vi.mock('./video-completion-access.js',()=>({authorizeVideoCompletionOrigin:vi.fn().mockResolvedValue(undefined)}));
import {authorizeVideoCompletionOrigin} from './video-completion-access.js';
import {createVideoAuthorization} from './video-tool-runtime.js';
function context(attributes:Record<string,unknown>={},extra:Record<string,unknown>={}):ToolContext {
  return {session:{...extra,auth:{current:{authenticator:'telegram',principalType:'user',principalId:'11111111-1111-4111-8111-111111111111',
    attributes:{familyId:'22222222-2222-4222-8222-222222222222',role:'member',telegramChatType:'private',telegramChatId:'123',
      telegramActorKind:'telegram_user',telegramActorId:'123',telegramUserId:'123',...attributes}}}}} as unknown as ToolContext;
}
describe('video live authorization',()=>{
  it('refuses a cancelled turn before reading storage',async()=>{
    const controller=new AbortController();controller.abort();const workspaceId=vi.fn();
    await expect(createVideoAuthorization({...context(),abortSignal:controller.signal},workspaceId)())
      .rejects.toMatchObject({code:'AGENT_VIDEO_TURN_CANCELLED'});
    expect(workspaceId).not.toHaveBeenCalled();
  });
  it('notices cancellation that arrives while the live workspace check is pending',async()=>{
    const controller=new AbortController();
    const workspaceId=vi.fn(async()=>{controller.abort();return '44444444-4444-4444-8444-444444444444';});
    await expect(createVideoAuthorization({...context(),abortSignal:controller.signal},workspaceId)())
      .rejects.toMatchObject({code:'AGENT_VIDEO_TURN_CANCELLED'});
  });
  it('derives person and destination from verified context and checks workspace on every use',async()=>{
    const workspaceId=vi.fn().mockResolvedValue('44444444-4444-4444-8444-444444444444');
    const authorize=createVideoAuthorization(context(),workspaceId);
    expect(await authorize()).toMatchObject({actorTelegramId:'123',scope:'personal',targetKey:'123:0',
      completionOrigin:{version:1,actorTelegramId:'123',target:{chatId:'123'},authorization:{userId:'11111111-1111-4111-8111-111111111111'}}});
    workspaceId.mockRejectedValue(new Error('Membership revoked'));
    await expect(authorize()).rejects.toThrow('Membership revoked');
  });
  it.each([
    [{telegramActorKind:'telegram_bot'},{}],
    [{telegramActorId:'456'},{}],
    [{scheduledRunId:'schedule-1'},{}],
    [{memoryReviewBatchId:'batch-1'},{}],
    [{},{parent:{sessionId:'parent-1'}}],
  ])('rejects unattended or unsupported callers before storage',async(attributes,extra)=>{
    const workspaceId=vi.fn();
    await expect(createVideoAuthorization(context(attributes,extra),workspaceId)()).rejects.toThrow();
    expect(workspaceId).not.toHaveBeenCalled();
  });
  it.each(['external','member','owner','recovery_owner'])('keeps %s in the external group scope and rechecks its grant after revocation',async(role)=>{
    const grant=vi.fn().mockResolvedValue(undefined);const workspaceId=vi.fn().mockResolvedValue('55555555-5555-4555-8555-555555555555');
    const authorize=createVideoAuthorization(context({role,groupType:'external',groupId:'33333333-3333-4333-8333-333333333333',
      telegramChatType:'group',telegramChatId:'-123'}),workspaceId,grant);
    expect(await authorize()).toMatchObject({scope:'group',actorTelegramId:'123'});
    expect(grant).toHaveBeenCalledWith({familyId:'22222222-2222-4222-8222-222222222222',groupId:'33333333-3333-4333-8333-333333333333'},'generate_video');
    grant.mockRejectedValue(new Error('Grant revoked'));
    await expect(authorize()).rejects.toThrow('Grant revoked');
    expect(workspaceId).toHaveBeenCalledTimes(1);
  });
  it('uses the family workspace only in a verified family group, preserving the topic',async()=>{
    const workspaceId=vi.fn().mockResolvedValue('66666666-6666-4666-8666-666666666666');
    expect(await createVideoAuthorization(context({telegramChatType:'supergroup',telegramChatId:'-123',
      groupType:'family_private',groupId:'33333333-3333-4333-8333-333333333333',telegramMessageThreadId:'42'}),workspaceId)())
      .toMatchObject({scope:'family',targetKey:'-123:42',actorTelegramId:'123'});
  });
  it('checks current application rights before returning access to a paid start',async()=>{
    vi.mocked(authorizeVideoCompletionOrigin).mockRejectedValueOnce(new Error('Child cannot write'));
    await expect(createVideoAuthorization(context(),vi.fn().mockResolvedValue('44444444-4444-4444-8444-444444444444'))())
      .rejects.toThrow('Child cannot write');
  });

});
