/** Real job/budget/lease/delivery ledgers; provider, file bytes and Telegram are controlled doubles. */
import {afterAll,beforeEach,describe,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({repository:null as any,deliver:vi.fn()}));
vi.mock('../attachments/telegram-workspace-file-delivery.js',()=>({deliverWorkspaceFile:m.deliver}));
vi.mock('../workspaces/workspace-file-delivery-repository.js',async importOriginal=>{
  const actual=await importOriginal<typeof import('../workspaces/workspace-file-delivery-repository.js')>();
  return {...actual,workspaceFileDeliveryRepository:{begin:(...args:any[])=>m.repository.begin(...args),
    complete:(...args:any[])=>m.repository.complete(...args),fail:(...args:any[])=>m.repository.fail(...args)}};
});
import {createTwoSpaceFixture,currentSpacePolicyVersion} from '../spaces/two-space-fixture.js';
import {recordAudienceProof} from '../spaces/telegram-audience-proof.js';
import {telegramIngressRepository} from '../telegram-ingress-repository.js';
import {reconcileVerifiedGroupMigration} from '../telegram-group-migration/reconcile.js';
import {resolveVideoCompletionDestination} from './video-migrated-destination.js';
import {database,closeDatabase} from '../database.js';
import {AppError} from '../app-error.js';
import {createWorkspaceFileDeliveryRepository} from '../workspaces/workspace-file-delivery-repository.js';
import {sendAuthorizedWorkspaceFile} from '../workspaces/workspace-file-sender.js';
import {authorizeSpaceDelivery} from '../spaces/space-delivery-authorization.js';
import {authorizeVideoCompletionOrigin} from './video-completion-access.js';
import {videoOperationRepository as operations} from './video-operation-repository.js';
import {videoBudgetRepository as budget} from './video-budget-repository.js';
import {videoCompletionQueue as queue} from './video-completion-queue.js';
import {createVideoCompletionRuntime} from './video-completion-runtime.js';
import {createVideoCompletionDispatcher} from './video-completion-dispatcher.js';
import {parseVideoCompletionOrigin} from './video-completion-origin.js';
import type {WorkspaceFileRecord} from '../workspaces/workspace-file-record.js';
const enabled=process.env.RUN_DATABASE_INTEGRATION_TESTS==='true';
if(enabled&&!new URL(process.env.DATABASE_URL!).pathname.endsWith('_test'))throw Error('Unsafe database');
let dispatch:ReturnType<typeof createVideoCompletionDispatcher>;
let saved:WorkspaceFileRecord|null;
let writes:number;
let fixture:Awaited<ReturnType<typeof createTwoSpaceFixture>>;
let original:unknown;
const provider={inspectStatus:vi.fn().mockResolvedValue({status:'completed',actualCostMicros:400000}),
  download:vi.fn().mockResolvedValue(Buffer.from('mp4'))};
(enabled?describe:describe.skip)('accepted video across verified group migration',()=>{
  beforeEach(async()=>{
    vi.clearAllMocks();saved=null;writes=0;
    m.deliver.mockResolvedValue({telegramMessageId:'777'});
    await database().query('TRUNCATE families,users,video_generation_operations,video_budget_reservations,video_budget_accounts,telegram_ingress_queues CASCADE');
    fixture=await createTwoSpaceFixture('paid-migration');
    const f=fixture;
    await database().query("UPDATE users SET telegram_user_id='998' WHERE id=$1",[f.owner.userId]);
    const workspace=(await database().query("INSERT INTO workspaces(family_id,scope) VALUES($1,'family') RETURNING id",[f.familyId])).rows[0].id;
    const origin=parseVideoCompletionOrigin({version:1,workspaceId:workspace,actorTelegramId:'998',scope:'family',target:{chatId:f.telegramChatId},
      authorization:{familyId:f.familyId,userId:f.owner.userId,role:'owner',groupId:f.groupId,groupType:'family_private',telegramChatType:'group'}});
    original=origin;
    await telegramIngressRepository.enqueue({updateId:'4005',continuationKey:f.telegramChatId,
      payload:{update_id:4005,message:{chat:{id:Number(f.telegramChatId),type:'group'},migrate_to_chat_id:-100998}}});
    await operations.begin({operationKey:'accepted-job',workspaceId:workspace,targetKey:`${fixture.telegramChatId}:0`,actorTelegramId:'998',inputHash:'a'.repeat(64),
      reservedMicros:500000,model:'bytedance/seedance-2.5',outputPath:'video.mp4',completionOrigin:origin});
    await operations.submitted('accepted-job','provider-job');
    await database().query("UPDATE video_generation_operations SET completion_due_at=now()-interval '1 second'");
    m.repository=createWorkspaceFileDeliveryRepository({readBinary:async()=>({bytes:Buffer.from('mp4'),file:saved!,workspaceId:workspace})});
    const resume=createVideoCompletionRuntime({resolveDestination:resolveVideoCompletionDestination,assertLease:queue.assertLease,authorizeOrigin:authorizeVideoCompletionOrigin,
      isMember:async()=>true,authorizeAudience:authorizeSpaceDelivery,workspaceId:async()=>workspace,operations,budget,client:provider,
      binary:{findBinaryWrite:async()=>saved,writeBinary:async()=>{writes++;return saved={path:'video.mp4',scope:'family',mediaType:'video/mp4',
        byteSize:3,contentSha256:'b'.repeat(64),updatedAt:new Date().toISOString()};}},send:sendAuthorizedWorkspaceFile});
    dispatch=createVideoCompletionDispatcher({queue,resume});
  });
  afterAll(closeDatabase);
  it('keeps one paid job through migration, waits for proof, then delivers once',async()=>{
    const active=await queue.claimOne('accepted-job');
    expect(active).not.toBeNull();
    await expect(reconcileVerifiedGroupMigration('4005')).rejects.toThrow(/MIGRATION_BUSY/);
    await queue.defer(active!,new Date(Date.now()-1000),null);
    await reconcileVerifiedGroupMigration('4005');
    await dispatch();
    expect(provider.inspectStatus).not.toHaveBeenCalled();expect(m.deliver).not.toHaveBeenCalled();
    expect((await database().query('SELECT delivery_state,completion_error_code FROM video_generation_operations')).rows[0])
      .toEqual({delivery_state:'pending',completion_error_code:'AGENT_VIDEO_MIGRATION_AUDIENCE_PENDING'});
    await database().query("UPDATE space_bindings SET state='active' WHERE group_id=$1",[fixture.groupId]);
    const client=await database().connect();
    try{await recordAudienceProof(client,{familyId:fixture.familyId,groupId:fixture.groupId,spaceId:fixture.pairSpaceId,
      policyVersion:await currentSpacePolicyVersion(fixture.pairSpaceId),botIsAdministrator:true,
      confirmedBy:fixture.owner.userId,declaredBotCount:1,observedMemberCount:3,roster:[fixture.owner.userId,fixture.spouse.userId]});}
    finally{client.release();}
    await database().query("UPDATE video_generation_operations SET completion_due_at=now()-interval '1 second'");
    await dispatch();await dispatch();
    expect(m.deliver).toHaveBeenCalledTimes(1);expect(writes).toBe(1);
    expect(m.deliver).toHaveBeenCalledWith(expect.objectContaining({chatId:'-100998'}));
    const result=(await database().query('SELECT delivery_state,completion_origin,target_key FROM video_generation_operations')).rows[0];
    expect(result).toEqual({delivery_state:'delivered',completion_origin:original,target_key:`${fixture.telegramChatId}:0`});
    expect((await database().query('SELECT count(*)::int n FROM video_budget_reservations')).rows[0].n).toBe(1);
    expect((await budget.balance('998')).usedMicros).toBe(400000);
    expect((await database().query('SELECT telegram_chat_id,status FROM workspace_file_deliveries')).rows)
      .toEqual([{telegram_chat_id:'-100998',status:'completed'}]);
  });
  it('does not use migration to retry an ambiguous send to the old chat',async()=>{
    m.deliver.mockRejectedValueOnce(new AppError('AGENT_WORKSPACE_FILE_DELIVERY_AMBIGUOUS','Unknown send'));
    await dispatch();
    expect(m.deliver).toHaveBeenCalledTimes(1);
    await expect(reconcileVerifiedGroupMigration('4005')).rejects.toThrow(/MIGRATION_BUSY/);
    await dispatch();
    expect(m.deliver).toHaveBeenCalledTimes(1);
    expect((await database().query('SELECT telegram_chat_id FROM telegram_groups WHERE id=$1',[fixture.groupId])).rows[0].telegram_chat_id)
      .toBe(fixture.telegramChatId);
    expect((await database().query('SELECT status FROM workspace_file_deliveries')).rows[0].status).toBe('started');
  });

});
