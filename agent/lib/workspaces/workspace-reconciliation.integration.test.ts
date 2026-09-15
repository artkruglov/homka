import {afterAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorkspaceDeletionWorker} from './workspace-deletion.js';
import {database,closeDatabase} from '../database.js';
import {reconcileLegacyWorkspaceRecords} from '../../../scripts/operations/reconcile-legacy-workspace.ts';

import {reconcileWorkspaceInstallation} from '../../../scripts/operations/reconcile-workspace-installation.ts';

const enabled=process.env.RUN_DATABASE_INTEGRATION_TESTS==='true';
if(enabled&&!new URL(process.env.DATABASE_URL!).pathname.endsWith('_test'))throw Error('Unsafe test database');
const suite=enabled?describe:describe.skip;
let family:string,owner:string,space:string,source:string,target:string;
async function attempt(preserve:(snapshot:any)=>Promise<void>=vi.fn(async()=>{}),targetId=target){
  const client=await database().connect();
  try{
    await client.query('BEGIN');
    const result=await reconcileLegacyWorkspaceRecords(client,{sourceId:source,targetId},preserve);
    await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
suite('operator legacy workspace reconciliation',()=>{
  beforeEach(async()=>{
    await database().query('TRUNCATE families,users,image_generation_operations,video_budget_accounts,video_generation_operations,workspace_deletion_jobs CASCADE');
    family=(await database().query("INSERT INTO families(name) VALUES('Reconcile') RETURNING id")).rows[0].id;
    owner=(await database().query("INSERT INTO users(telegram_user_id,display_name) VALUES('998','Owner') RETURNING id")).rows[0].id;
    await database().query("INSERT INTO family_memberships(family_id,user_id,role) VALUES($1,$2,'owner')",[family,owner]);
    space=(await database().query("INSERT INTO spaces(family_id,owner_user_id,kind,title,legacy_scope) VALUES($1,$2,'personal','Legacy','personal') RETURNING id",[family,owner])).rows[0].id;
    source=(await database().query("INSERT INTO workspaces(family_id,owner_user_id,scope,space_id) VALUES($1,$2,'personal',$3) RETURNING id",[family,owner,space])).rows[0].id;
    target=(await database().query("INSERT INTO workspaces(family_id,owner_user_id,scope) VALUES($1,$2,'personal') RETURNING id",[family,owner])).rows[0].id;
    await database().query("INSERT INTO workspace_operations(operation_key,workspace_id,operation_type,result,space_id) VALUES('old-write',$1,'binary_write',$2,$3),('new-write',$4,'binary_write',$5,NULL)",[source,{path:'old.png',contentSha256:'a'.repeat(64)},space,target,{path:'new.png',contentSha256:'b'.repeat(64)}]);
    await database().query("INSERT INTO image_generation_operations(operation_key,workspace_id,input_hash,output_path,status,result,completed_at,space_id) VALUES('image-old',$1,$2,'old.png','completed',$3,now(),$4)",[source,'c'.repeat(64),{path:'old.png'},space]);
  });
  afterAll(closeDatabase);
  it('preserves receipts and current root ID, and queues only retired root cleanup',async()=>{
    const preserve=vi.fn(async(_snapshot:unknown)=>{});
    await attempt(preserve);
    expect(preserve).toHaveBeenCalledTimes(1);
    expect(preserve.mock.calls[0]![0]).toMatchObject({source:{id:source},target:{id:target}});
    const roots=await database().query('SELECT id,space_id FROM workspaces ORDER BY id');
    expect(roots.rows).toEqual([{id:target,space_id:space}]);
    expect((await database().query('SELECT operation_key,workspace_id FROM workspace_operations ORDER BY operation_key')).rows)
      .toEqual([{operation_key:'new-write',workspace_id:target},{operation_key:'old-write',workspace_id:target}]);
    expect((await database().query("SELECT workspace_id,input_hash,result,space_id FROM image_generation_operations WHERE operation_key='image-old'")).rows[0])
      .toEqual({workspace_id:target,input_hash:'c'.repeat(64),result:{path:'old.png'},space_id:space});
    expect((await database().query('SELECT workspace_id FROM workspace_deletion_jobs')).rows).toEqual([{workspace_id:source}]);
  });
  it('rolls back without deleting anything when preservation fails',async()=>{
    await expect(attempt(vi.fn(async()=>{throw Error('archive unavailable');}))).rejects.toThrow('archive unavailable');
    expect((await database().query('SELECT count(*)::int n FROM workspaces')).rows[0].n).toBe(2);
    expect((await database().query('SELECT count(*)::int n FROM workspace_deletion_jobs')).rows[0].n).toBe(0);
  });
  it('does not merge another personal owner even in the same family',async()=>{
    const other=(await database().query("INSERT INTO users(telegram_user_id,display_name) VALUES('999','Other') RETURNING id")).rows[0].id;
    const otherRoot=(await database().query("INSERT INTO workspaces(family_id,owner_user_id,scope) VALUES($1,$2,'personal') RETURNING id",[family,other])).rows[0].id;
    const preserve=vi.fn(async()=>{});
    await expect(attempt(preserve,otherRoot)).rejects.toThrow('BOUNDARY_MISMATCH');
    expect(preserve).not.toHaveBeenCalled();
  });
  it('refuses active paid work before preservation',async()=>{
    await database().query("INSERT INTO image_generation_operations(operation_key,workspace_id,input_hash,output_path) VALUES('pending',$1,$2,'pending.png')",[target,'d'.repeat(64)]);
    const preserve=vi.fn(async()=>{});
    await expect(attempt(preserve)).rejects.toThrow('ACTIVE_OPERATION');expect(preserve).not.toHaveBeenCalled();
  });
  it('requires old conversations to be retired first',async()=>{
    await database().query("INSERT INTO conversation_sessions(kind,thread_id,generation,family_id,owner_user_id,scope,conversation_key,continuation_token,started_at,last_activity_at) VALUES('canonical',gen_random_uuid(),0,$1,$2,'personal','test','reconcile-test',now(),now())",[family,owner]);
    await expect(attempt()).rejects.toThrow('LIVE_CONVERSATION');
  });
  it('refuses unknown workspace-bearing tables instead of silently losing references',async()=>{
    await database().query('CREATE TABLE reconciliation_unknown(workspace_id uuid REFERENCES workspaces(id))');
    try{await expect(attempt()).rejects.toThrow('SCHEMA_CHANGED');}
    finally{await database().query('DROP TABLE reconciliation_unknown');}
  });
  it('restores all moved receipts if the final binding fails',async()=>{
    await database().query("CREATE FUNCTION reconcile_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'late failure'; END $$; CREATE TRIGGER reconcile_test_fail BEFORE UPDATE OF space_id ON workspaces FOR EACH ROW EXECUTE FUNCTION reconcile_test_fail()");
    const preserve=vi.fn(async()=>{});
    try{await expect(attempt(preserve)).rejects.toThrow('late failure');}
    finally{await database().query('DROP TRIGGER reconcile_test_fail ON workspaces; DROP FUNCTION reconcile_test_fail()');}
    expect(preserve).toHaveBeenCalledTimes(1);
    expect((await database().query("SELECT workspace_id FROM workspace_operations WHERE operation_key='old-write'")).rows[0].workspace_id).toBe(source);
    expect((await database().query('SELECT count(*)::int n FROM workspaces')).rows[0].n).toBe(2);
    expect((await database().query('SELECT count(*)::int n FROM workspace_deletion_jobs')).rows[0].n).toBe(0);
  });
  it('preserves completed video billing and delivery keys without a second reservation',async()=>{
    await database().query("INSERT INTO video_budget_accounts(actor_telegram_id,month) VALUES('998','2026-09')");
    await database().query("INSERT INTO video_budget_reservations(operation_key,actor_telegram_id,month,input_hash,reserved_micros,actual_micros,settled_at) VALUES('video-old','998','2026-09',$1,500000,415481,now())",['e'.repeat(64)]);
    await database().query("INSERT INTO video_generation_operations(operation_key,workspace_id,target_key,model,output_path,status,job_id,result) VALUES('video-old',$1,'998:0','bytedance/seedance-2.5','old.mp4','completed','original-job',$2)",[source,{path:'old.mp4'}]);
    await database().query("INSERT INTO workspace_file_deliveries(family_id,workspace_id,file_path,content_sha256,operation_key,telegram_chat_id,presentation,status,telegram_message_id,completed_at,space_id) VALUES($1,$2,'old.mp4',$3,'delivery-old','998','document','completed','321',now(),$4)",[family,source,'f'.repeat(64),space]);
    const before=(await database().query('SELECT to_jsonb(r) value FROM video_budget_reservations r')).rows;
    await attempt();
    expect((await database().query('SELECT to_jsonb(r) value FROM video_budget_reservations r')).rows).toEqual(before);
    expect((await database().query("SELECT workspace_id,job_id FROM video_generation_operations WHERE operation_key='video-old'")).rows[0]).toEqual({workspace_id:target,job_id:'original-job'});
    expect((await database().query("SELECT workspace_id,telegram_message_id FROM workspace_file_deliveries WHERE operation_key='delivery-old'")).rows[0]).toEqual({workspace_id:target,telegram_message_id:'321'});
  });
  it('cleanup removes only retired root paths while archives and current files remain',async()=>{
    const root=await mkdtemp(join(tmpdir(),'workspace-reconcile-cleanup-'));
    const files=join(root,'files'),tools=join(root,'tools');
    const paths=[join(files,source),join(files,target),join(files,'.reconciliation-archive',source),
      join(tools,source),join(tools,target),join(tools,'.reconciliation-archive',source)];
    try{
      for(const path of paths){await mkdir(path,{recursive:true});await writeFile(join(path,'preserved.txt'),'preserved');}
      await attempt();
      const cleanup=createWorkspaceDeletionWorker(files,async id=>{await rm(join(tools,id),{recursive:true,force:true});});
      expect(await cleanup()).toBe(1);
      for(const path of [paths[0]!,paths[3]!])await expect(access(path)).rejects.toMatchObject({code:'ENOENT'});
      for(const path of [paths[1]!,paths[2]!,paths[4]!,paths[5]!])expect(await readFile(join(path,'preserved.txt'),'utf8')).toBe('preserved');
      expect((await database().query('SELECT count(*)::int n FROM workspace_deletion_jobs')).rows[0].n).toBe(0);
    }finally{await rm(root,{recursive:true,force:true});}
  });
  it('installation refuses a stale reviewed pair set before retiring conversations',async()=>{
    const client=await database().connect();
    try{
      await expect(reconcileWorkspaceInstallation(client,[{sourceId:source,targetId:crypto.randomUUID()}],
        async()=>{}, {reason:'test'})).rejects.toThrow('PAIR_SET_CHANGED');
      expect((await client.query('SELECT count(*)::int n FROM workspaces')).rows[0].n).toBe(2);
    }finally{client.release();}
  });
  it('installation rollback rehearsal keeps all roots and receipts intact',async()=>{
    const client=await database().connect();
    try{
      const result=await reconcileWorkspaceInstallation(client,[{sourceId:source,targetId:target}],
        async()=>{}, {reason:'test',rollbackOnly:true});
      expect(result.committed).toBe(false);
      expect((await client.query('SELECT count(*)::int n FROM workspaces')).rows[0].n).toBe(2);
      expect((await client.query('SELECT count(*)::int n FROM workspace_deletion_jobs')).rows[0].n).toBe(0);
    }finally{client.release();}
  });
  it('installation rolls back the first pair when preservation of the second fails',async()=>{
    const familySpace=(await database().query("INSERT INTO spaces(family_id,kind,title,legacy_scope) VALUES($1,'legacy_family','Legacy family','family') RETURNING id",[family])).rows[0].id;
    const source2=(await database().query("INSERT INTO workspaces(family_id,scope,space_id) VALUES($1,'family',$2) RETURNING id",[family,familySpace])).rows[0].id;
    const target2=(await database().query("INSERT INTO workspaces(family_id,scope) VALUES($1,'family') RETURNING id",[family])).rows[0].id;
    const client=await database().connect();
    const preserve=vi.fn(async(snapshot:any)=>{if(snapshot.source.id===source2)throw Error('second archive unavailable');});
    try{
      await expect(reconcileWorkspaceInstallation(client,[{sourceId:source,targetId:target},
        {sourceId:source2,targetId:target2}],preserve,{reason:'test'})).rejects.toThrow('second archive unavailable');
      expect(preserve).toHaveBeenCalledTimes(2);
      expect((await client.query('SELECT count(*)::int n FROM workspaces')).rows[0].n).toBe(4);
      expect((await client.query("SELECT workspace_id FROM workspace_operations WHERE operation_key='old-write'")).rows[0].workspace_id).toBe(source);
      expect((await client.query('SELECT count(*)::int n FROM workspace_deletion_jobs')).rows[0].n).toBe(0);
    }finally{client.release();}
  });
  it('fails closed on a second invocation instead of fabricating a successful repeat',async()=>{
    await attempt();await expect(attempt()).rejects.toThrow('ROOT_PAIR_MISSING');
  });
});
