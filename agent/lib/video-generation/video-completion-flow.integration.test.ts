/** Real job/budget/lease/delivery ledgers; provider, file bytes and Telegram are controlled doubles. */
import {afterAll,beforeEach,describe,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({repository:null as any,deliver:vi.fn()}));
vi.mock('../attachments/telegram-workspace-file-delivery.js',()=>({deliverWorkspaceFile:m.deliver}));
vi.mock('../workspaces/workspace-file-delivery-repository.js',async importOriginal=>{
  const actual=await importOriginal<typeof import('../workspaces/workspace-file-delivery-repository.js')>();
  return {...actual,workspaceFileDeliveryRepository:{begin:(...args:any[])=>m.repository.begin(...args),
    complete:(...args:any[])=>m.repository.complete(...args),fail:(...args:any[])=>m.repository.fail(...args)}};
});
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
const provider={inspectStatus:vi.fn().mockResolvedValue({status:'completed',actualCostMicros:400000}),
  download:vi.fn().mockResolvedValue(Buffer.from('mp4'))};
(enabled?describe:describe.skip)('accepted video completion across restarts',()=>{
  beforeEach(async()=>{
    vi.clearAllMocks();saved=null;writes=0;
    m.deliver.mockResolvedValue({telegramMessageId:'777'});
    await database().query('TRUNCATE families,users,video_generation_operations,video_budget_reservations,video_budget_accounts CASCADE');
    const family=(await database().query("INSERT INTO families(name) VALUES('Completion test') RETURNING id")).rows[0].id;
    const user=(await database().query("INSERT INTO users(telegram_user_id,display_name) VALUES('998','Video tester') RETURNING id")).rows[0].id;
    await database().query("INSERT INTO family_memberships(family_id,user_id,role) VALUES($1,$2,'owner')",[family,user]);
    const workspace=(await database().query("INSERT INTO workspaces(family_id,owner_user_id,scope) VALUES($1,$2,'personal') RETURNING id",[family,user])).rows[0].id;
    const origin=parseVideoCompletionOrigin({version:1,workspaceId:workspace,actorTelegramId:'998',scope:'personal',target:{chatId:'998'},
      authorization:{familyId:family,userId:user,role:'owner',groupId:null,groupType:null,telegramChatType:'private'}});
    await operations.begin({operationKey:'accepted-job',workspaceId:workspace,targetKey:'998:0',actorTelegramId:'998',inputHash:'a'.repeat(64),
      reservedMicros:500000,model:'bytedance/seedance-2.5',outputPath:'video.mp4',completionOrigin:origin});
    await operations.submitted('accepted-job','provider-job');
    await database().query("UPDATE video_generation_operations SET completion_due_at=now()-interval '1 second'");
    m.repository=createWorkspaceFileDeliveryRepository({readBinary:async()=>({bytes:Buffer.from('mp4'),file:saved!,workspaceId:workspace})});
    const resume=createVideoCompletionRuntime({resolveDestination:resolveVideoCompletionDestination,assertLease:queue.assertLease,authorizeOrigin:authorizeVideoCompletionOrigin,
      isMember:async()=>true,authorizeAudience:authorizeSpaceDelivery,workspaceId:async()=>workspace,operations,budget,client:provider,
      binary:{findBinaryWrite:async()=>saved,writeBinary:async()=>{writes++;return saved={path:'video.mp4',scope:'personal',mediaType:'video/mp4',
        byteSize:3,contentSha256:'b'.repeat(64),updatedAt:new Date().toISOString()};}},send:sendAuthorizedWorkspaceFile});
    dispatch=createVideoCompletionDispatcher({queue,resume});
  });
  afterAll(closeDatabase);
  it('recovers an expired owner and sends once with one unchanged budget reservation',async()=>{
    const abandoned=await queue.claimOne('accepted-job');expect(abandoned).toBeTruthy();
    await database().query("UPDATE video_generation_operations SET completion_lease_until=now()-interval '1 second'");
    await dispatch();await dispatch();
    expect(m.deliver).toHaveBeenCalledTimes(1);expect(writes).toBe(1);
    const result=(await database().query('SELECT delivery_state FROM video_generation_operations')).rows[0];
    expect(result.delivery_state).toBe('delivered');
    expect((await database().query('SELECT count(*)::int n FROM video_budget_reservations')).rows[0].n).toBe(1);
    expect((await budget.balance('998')).usedMicros).toBe(400000);
    await expect(queue.finish(abandoned!,'delivered',new Date())).rejects.toThrow('LEASE_STALE');
  });
  it('never retransmits after an ambiguous Telegram result, including the next process pass',async()=>{
    m.deliver.mockRejectedValueOnce(new AppError('AGENT_WORKSPACE_FILE_DELIVERY_AMBIGUOUS','Unknown result'));
    await dispatch();await dispatch();
    expect(m.deliver).toHaveBeenCalledTimes(1);
    expect((await database().query('SELECT delivery_state FROM video_generation_operations')).rows[0].delivery_state).toBe('failed');
    expect((await database().query('SELECT status FROM workspace_file_deliveries')).rows[0].status).toBe('started');
  });
  it('allows only one competing minute pass to download and deliver',async()=>{
    await Promise.all([dispatch(),dispatch()]);expect(m.deliver).toHaveBeenCalledTimes(1);expect(writes).toBe(1);
  });
});
