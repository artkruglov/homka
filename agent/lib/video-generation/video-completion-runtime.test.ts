import {it,expect,vi} from 'vitest';
import {AppError} from '../app-error.js';
import {parseVideoCompletionOrigin} from './video-completion-origin.js';
import {createVideoCompletionRuntime} from './video-completion-runtime.js';
const id='12345678-1234-4234-8234-123456789abc';
const origin=parseVideoCompletionOrigin({version:1,workspaceId:id,actorTelegramId:'998',scope:'personal',target:{chatId:'998'},
  authorization:{familyId:id,userId:id,groupId:null,groupType:null,role:'owner',telegramChatType:'private'}});
const file={path:'video.mp4',scope:'personal' as const,mediaType:'video/mp4',byteSize:3,contentSha256:'a'.repeat(64),updatedAt:'2026-09-13T00:00:00Z'};
const job={operationKey:'job',leaseToken:id,origin};
function setup(){
  const deps={resolveDestination:vi.fn().mockImplementation(async value=>value),assertLease:vi.fn(),authorizeOrigin:vi.fn(),isMember:vi.fn().mockResolvedValue(true),
    authorizeAudience:vi.fn().mockResolvedValue({allowed:true}),workspaceId:vi.fn().mockResolvedValue(id),
    operations:{get:vi.fn().mockResolvedValue({operationKey:'job',workspaceId:id,targetKey:'998:0',model:'bytedance/seedance-2.5',
      outputPath:'video.mp4',status:'submitted',jobId:'provider-job',file:null,errorCode:null,completionOrigin:origin}),complete:vi.fn(),fail:vi.fn()},
    budget:{settle:vi.fn()},client:{inspectStatus:vi.fn().mockResolvedValue({status:'completed',actualCostMicros:400000}),download:vi.fn().mockResolvedValue(Buffer.from('mp4'))},
    binary:{findBinaryWrite:vi.fn().mockResolvedValue(null),writeBinary:vi.fn().mockResolvedValue(file)},
    send:vi.fn().mockResolvedValue({delivered:true})};
  return {deps,resume:createVideoCompletionRuntime(deps)};
}
it('finishes a persisted job with its original destination and stable delivery key',async()=>{
  const s=setup();expect(await s.resume(job)).toMatchObject({status:'completed',delivery:{delivered:true}});
  expect(s.deps.client.inspectStatus).toHaveBeenCalledWith('provider-job');
  expect(s.deps.send).toHaveBeenCalledWith(expect.objectContaining({path:'video.mp4',scope:'personal'}),expect.objectContaining({
    operationKey:'video-delivery:job',target:{chatId:'998'},projection:{applicationSessionId:null,forumTopicId:null,replyToEntryId:null}}));
  const context=s.deps.send.mock.calls[0]![1];await context.beforeSend();
  expect(s.deps.assertLease).toHaveBeenCalledWith(job);
});
it('rejects a substituted saved origin or a newly resolved workspace before polling',async()=>{
  for(const change of ['origin','workspace']){
    const s=setup();
    if(change==='origin')s.deps.operations.get.mockResolvedValueOnce({...await s.deps.operations.get(),completionOrigin:{...origin,actorTelegramId:'999'}});
    else s.deps.workspaceId.mockResolvedValue('another-root');
    await expect(s.resume(job)).rejects.toThrow('ACCESS_CHANGED');expect(s.deps.client.inspectStatus).not.toHaveBeenCalled();
  }
});
it('rechecks revocation after downloading and before saving or delivering',async()=>{
  const s=setup();s.deps.client.download.mockImplementation(async()=>{
    s.deps.authorizeOrigin.mockRejectedValue(new AppError('AGENT_VIDEO_COMPLETION_ACCESS_REVOKED','Revoked'));
    return Buffer.from('mp4');
  });
  await expect(s.resume(job)).rejects.toThrow('ACCESS_REVOKED');
  expect(s.deps.binary.writeBinary).not.toHaveBeenCalled();expect(s.deps.send).not.toHaveBeenCalled();
});
it('refuses a stale lease or unproven audience before contacting the provider',async()=>{
  for(const reason of ['lease','audience']){
    const s=setup();
    if(reason==='lease')s.deps.assertLease.mockRejectedValue(new AppError('AGENT_VIDEO_COMPLETION_LEASE_STALE','Expired'));
    else s.deps.authorizeAudience.mockResolvedValue({allowed:false,code:'AGENT_SPACE_DELIVERY_AUDIENCE_UNPROVEN'});
    await expect(s.resume(job)).rejects.toThrow();expect(s.deps.client.inspectStatus).not.toHaveBeenCalled();
  }
});
it('requires the video author still to belong to the original Telegram group',async()=>{
  const s=setup();s.deps.isMember.mockResolvedValue(false);
  const grouped=parseVideoCompletionOrigin({...origin,scope:'group',target:{chatId:'-998'},authorization:{...origin.authorization,
    userId:null,role:'external',groupId:id,groupType:'external',telegramChatType:'group'}});
  await expect(s.resume({...job,origin:grouped})).rejects.toThrow('ACCESS_REVOKED');
  expect(s.deps.isMember).toHaveBeenCalledWith('-998','998');expect(s.deps.client.inspectStatus).not.toHaveBeenCalled();
});

it('sends migrated output to the verified destination while reading the original operation key',async()=>{
  const s=setup();
  const grouped=parseVideoCompletionOrigin({...origin,scope:'family',target:{chatId:'-998'},authorization:{...origin.authorization,
    groupId:id,groupType:'family_private',telegramChatType:'group'}});
  const resolved={...grouped,target:{chatId:'-100998'},forumTopicId:null,
    authorization:{...grouped.authorization,telegramChatType:'supergroup' as const}};
  s.deps.resolveDestination.mockResolvedValue(resolved);
  s.deps.binary.writeBinary.mockResolvedValue({...file,scope:'family'});
  s.deps.operations.get.mockResolvedValue({...await s.deps.operations.get(),completionOrigin:grouped,targetKey:'-998:0'});
  await s.resume({...job,origin:grouped});
  expect(s.deps.operations.get).toHaveBeenCalledWith('job',id,'-998:0','998');
  expect(s.deps.isMember).toHaveBeenCalledWith('-100998','998');
  expect(s.deps.send).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({target:{chatId:'-100998'},operationKey:'video-delivery:job'}));
  expect(s.deps.authorizeOrigin).toHaveBeenCalledWith(resolved);
});
