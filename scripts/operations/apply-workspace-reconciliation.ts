/** Host operator entrypoint, never a model tool or migration. See family-deploy runbook.
 * Host must hold release lock, stop ALL writers/sandboxes, verify before-backup, archive and
 * recheck physical roots, and mount private receipts plus exact volume roots. No provider keys.
 * Two phases permit physical readback between metadata commit and native cleanup. Failures
 * require inspection; neither this entrypoint nor its caller may restore an older live DB.
 */
import pg from 'pg';
import {readFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {reconcileWorkspaceInstallation,type WorkspacePair} from './reconcile-workspace-installation.ts';
import {writeOperatorReceipt} from './durable-operator-receipt.ts';
import {createWorkspaceDeletionWorker} from '../../agent/lib/workspaces/workspace-deletion.ts';
import {closeDatabase} from '../../agent/lib/database.ts';
import {backfillSpaceRecords104} from '../migration-data/space-records-104.ts';
import {bindLateSpaceRecords} from '../../agent/lib/spaces/bind-late-space-records.ts';
import {auditLegacySpaces} from '../../agent/lib/spaces/legacy-space-audit.ts';

const phase=process.argv[2];
if(process.argv.length!==4||!['metadata','cleanup'].includes(phase??'')||process.argv[3]!=='--execute'){
  throw Error('AGENT_WORKSPACE_OPERATOR_EXPLICIT_PHASE_REQUIRED');
}
const url=new URL(process.env.DATABASE_URL??'http://missing');
if(url.protocol!=='postgresql:'||url.hostname!=='127.0.0.1'||
  !['/osinara','/osinara_workspace_rehearsal'].includes(url.pathname)){
  throw Error('AGENT_WORKSPACE_OPERATOR_DATABASE_REQUIRED');
}
const planBytes=await readFile('/receipt/plan.json');
const plan=JSON.parse(planBytes.toString()) as {runId:string;pairs:WorkspacePair[]};
if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(plan.runId)||!Array.isArray(plan.pairs)||!plan.pairs.length){
  throw Error('AGENT_WORKSPACE_OPERATOR_PLAN_INVALID');
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
for(const pair of plan.pairs)if(!uuid.test(pair.sourceId)||!uuid.test(pair.targetId)){
  throw Error('AGENT_WORKSPACE_OPERATOR_PLAN_INVALID');
}
const planSha256=createHash('sha256').update(planBytes).digest('hex');
const pool=new pg.Pool({connectionString:url.toString(),max:1});
const client=await pool.connect();
async function counts(){return (await client.query(`SELECT
  (SELECT count(*)::int FROM shared_tasks) tasks,
  (SELECT count(*)::int FROM memory_items_all) memories,
  (SELECT count(*)::int FROM reminders) reminders,
  (SELECT count(*)::int FROM workspace_operations) operations,
  (SELECT count(*)::int FROM image_generation_operations) images,
  (SELECT count(*)::int FROM video_generation_operations) videos,
  (SELECT count(*)::int FROM video_budget_reservations) video_reservations,
  (SELECT count(*)::int FROM workspace_file_deliveries) deliveries`)).rows[0];}
try{
  const schema=(await client.query('SELECT max(name) AS name FROM schema_migrations')).rows[0].name;
  if(schema!=='133_video_space_binding.sql')throw Error('AGENT_WORKSPACE_OPERATOR_SCHEMA_CHANGED');
  const runtime=(await client.query('SELECT mode FROM family_space_runtime')).rows;
  if(!runtime.length||runtime.some(r=>r.mode!=='legacy'))throw Error('AGENT_WORKSPACE_OPERATOR_RUNTIME_CHANGED');
  if(phase==='metadata'){
    const before=await counts();
    await writeOperatorReceipt('/receipt/before-metadata.json',{planSha256,counts:before});
    const result=await reconcileWorkspaceInstallation(client,plan.pairs,async snapshot=>{
      const bytes=await readFile(`/receipt/preservation/${snapshot.source.id}.json`);
      const physical=JSON.parse(bytes.toString());
      if(physical.sourceId!==snapshot.source.id||physical.targetId!==snapshot.target.id||
        physical.runId!==plan.runId||!physical.roots?.files?.source||!physical.roots?.files?.current){
        throw Error('AGENT_WORKSPACE_OPERATOR_PHYSICAL_PROOF_MISMATCH');
      }
      // Host verifies the actual trees while stopped; preserve the exact verified inventories
      // with each database snapshot, not only a boolean which could outlive the original proof.
      await writeOperatorReceipt(`/receipt/snapshot-${snapshot.source.id}.json`,
        {planSha256,snapshot,physicalProof:physical,proofSha256:createHash('sha256').update(bytes).digest('hex')});
    },{reason:`workspace-reconciliation:${plan.runId}`});
    const after=await counts();
    if(JSON.stringify(before)!==JSON.stringify(after))throw Error('AGENT_WORKSPACE_OPERATOR_COUNT_CHANGED_AFTER_COMMIT');
    await writeOperatorReceipt('/receipt/metadata-committed.json',{planSha256,counts:after,result});
    console.log(JSON.stringify({phase,committed:true,pairs:plan.pairs.length,counts:after}));
  }else{
    const committed=JSON.parse(await readFile('/receipt/metadata-committed.json','utf8'));
    if(committed.planSha256!==planSha256)throw Error('AGENT_WORKSPACE_OPERATOR_COMMIT_PROOF_MISMATCH');
    const queued=(await client.query<{workspace_id:string}>('SELECT workspace_id FROM workspace_deletion_jobs')).rows;
    const sources=new Set(plan.pairs.map(p=>p.sourceId));
    if(queued.some(r=>!sources.has(r.workspace_id)))throw Error('AGENT_WORKSPACE_OPERATOR_UNEXPECTED_CLEANUP');
    for(const pair of plan.pairs){
      const roots=(await client.query('SELECT id,space_id FROM workspaces WHERE id=ANY($1::uuid[])',[[pair.sourceId,pair.targetId]])).rows;
      const saved=JSON.parse(await readFile(`/receipt/snapshot-${pair.sourceId}.json`,'utf8'));
      if(saved.planSha256!==planSha256||roots.length!==1||roots[0].id!==pair.targetId||
        roots[0].space_id!==saved.snapshot.source.space_id)throw Error('AGENT_WORKSPACE_OPERATOR_ROOT_CHANGED');
    }
    const cleanup=createWorkspaceDeletionWorker('/files',async id=>{
      if(!sources.has(id))throw Error('AGENT_WORKSPACE_OPERATOR_UNEXPECTED_CLEANUP');
      await rm(`/tools/${id}`,{recursive:true,force:true});
    });
    await cleanup();
    await client.query('BEGIN');
    await backfillSpaceRecords104(client);await bindLateSpaceRecords(client);
    await client.query('COMMIT');
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const audit=await auditLegacySpaces(client);await client.query('ROLLBACK');
    const after=await counts();
    if(JSON.stringify(committed.counts)!==JSON.stringify(after))throw Error('AGENT_WORKSPACE_OPERATOR_COUNT_CHANGED');
    await writeOperatorReceipt('/receipt/cleanup-result.json',{planSha256,counts:after,audit,spacesCutover:false});
    if(audit.blockers.length)throw Error('AGENT_WORKSPACE_OPERATOR_AUDIT_BLOCKED');
    console.log(JSON.stringify({phase,counts:after,blockers:[],spacesCutover:false}));
  }
}catch(error){await client.query('ROLLBACK');throw error;}
finally{client.release();await pool.end();await closeDatabase();}
