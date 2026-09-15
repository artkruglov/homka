/** Isolated rehearsal, optionally with copied files. No production URL or service credentials. */
import pg from 'pg';
import {createHash} from 'node:crypto';
import {mkdir,readFile,rm} from 'node:fs/promises';
import {createWorkspaceDeletionWorker} from '../../agent/lib/workspaces/workspace-deletion.ts';
import {closeDatabase} from '../../agent/lib/database.ts';
import {backfillSpaceRecords104} from '../migration-data/space-records-104.ts';
import {bindLateSpaceRecords} from '../../agent/lib/spaces/bind-late-space-records.ts';
import {auditLegacySpaces} from '../../agent/lib/spaces/legacy-space-audit.ts';
import {reconcileWorkspaceInstallation} from './reconcile-workspace-installation.ts';
import {writeOperatorReceipt} from './durable-operator-receipt.ts';

const url=new URL(process.env.DATABASE_URL??'http://missing');
if(url.protocol!=='postgresql:'||url.hostname!=='127.0.0.1'||url.pathname!=='/osinara_workspace_rehearsal'){
  throw Error('AGENT_WORKSPACE_REHEARSAL_DATABASE_REQUIRED');
}
const pool=new pg.Pool({connectionString:url.toString(),max:1});
const client=await pool.connect();
const physical=process.env.OSINARA_REHEARSAL_FILES==='1';
const directory='/receipt/workspace-records';
await mkdir(directory,{recursive:true,mode:0o700});
async function fingerprint(){
  const rows=(await client.query(`SELECT to_jsonb(w)::text AS value FROM workspaces w ORDER BY id`)).rows;
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
try{
  const before=await fingerprint();
  if(physical&&(await client.query('SELECT 1 FROM workspace_deletion_jobs LIMIT 1')).rowCount)throw Error('REHEARSAL_EXISTING_CLEANUP');
  const initialCounts=(await client.query(`SELECT
    (SELECT count(*)::int FROM shared_tasks) tasks,
    (SELECT count(*)::int FROM memory_items_all) memories,
    (SELECT count(*)::int FROM workspace_operations) operations,
    (SELECT count(*)::int FROM image_generation_operations) images,
    (SELECT count(*)::int FROM video_generation_operations) videos,
    (SELECT count(*)::int FROM workspace_file_deliveries) deliveries`)).rows[0];
  const pairs=(await client.query<{source_id:string;target_id:string;family_id:string}>(`SELECT old.id source_id,new.id target_id,old.family_id
    FROM workspaces old JOIN workspaces new ON old.family_id=new.family_id AND old.scope=new.scope
      AND old.owner_user_id IS NOT DISTINCT FROM new.owner_user_id AND old.group_id IS NOT DISTINCT FROM new.group_id
    WHERE old.space_id IS NOT NULL AND new.space_id IS NULL ORDER BY old.id`)).rows;
  if(pairs.length===0)throw Error('AGENT_WORKSPACE_REHEARSAL_NO_PAIRS');
  const reports=[];
  for(const phase of ['rollback','commit']){
    const result=await reconcileWorkspaceInstallation(client,
      pairs.map(pair=>({sourceId:pair.source_id,targetId:pair.target_id})),async snapshot=>{
        let physicalProof:unknown=null;
        if(physical){
          // Only the stopped isolated copies are mounted; Python verifies their inventories.
          const receipt=JSON.parse(await readFile(`/receipt/preservation/${snapshot.source.id}.json`,'utf8'));
          if(receipt.sourceId!==snapshot.source.id||receipt.targetId!==snapshot.target.id||
            receipt.sourceCovered!==true||receipt.filesArchived!==true||receipt.toolsArchived!==true){
            throw Error('REHEARSAL_PHYSICAL_PRESERVATION_MISSING');
          }
          physicalProof=receipt;
        }
        await writeOperatorReceipt(`${directory}/${phase}-${snapshot.source.id}.json`,
          {metadataOnly:!physical,snapshot,physicalProof});
      },{rollbackOnly:phase==='rollback',reason:'isolated-workspace-rehearsal'});
    if(phase==='rollback'&&(await fingerprint())!==before)throw Error('AGENT_WORKSPACE_REHEARSAL_ROLLBACK_MISMATCH');
    reports.push({phase,moved:result.moved});
  }
  const finalCounts=(await client.query(`SELECT
    (SELECT count(*)::int FROM shared_tasks) tasks,
    (SELECT count(*)::int FROM memory_items_all) memories,
    (SELECT count(*)::int FROM workspace_operations) operations,
    (SELECT count(*)::int FROM image_generation_operations) images,
    (SELECT count(*)::int FROM video_generation_operations) videos,
    (SELECT count(*)::int FROM workspace_file_deliveries) deliveries`)).rows[0];
  if(JSON.stringify(initialCounts)!==JSON.stringify(finalCounts))throw Error('AGENT_WORKSPACE_REHEARSAL_COUNT_MISMATCH');
  let spaceAudit:unknown=null;
  if(physical){
    const cleanup=createWorkspaceDeletionWorker('/receipt/fs/files',async id=>{
      await rm(`/receipt/fs/tools/${id}`,{recursive:true,force:true});
    });
    if(await cleanup()!==pairs.length)throw Error('REHEARSAL_CLEANUP_COUNT_MISMATCH');
    await client.query('BEGIN');
    await backfillSpaceRecords104(client);
    await bindLateSpaceRecords(client);
    await client.query('COMMIT');
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    spaceAudit=await auditLegacySpaces(client);
    await client.query('ROLLBACK');
  }
  const output={metadataRehearsalPassed:true,physicalPreservationTested:physical,spaceAudit,
    fullSpacesRehearsalPassed:false,cleanupPending:!physical,counts:finalCounts,reports};
  await writeOperatorReceipt(`${directory}/result.json`,output);
  console.log(JSON.stringify({metadataRehearsalPassed:true,physicalPreservationTested:physical,pairs:pairs.length,counts:finalCounts,spaceAuditBlockers:(spaceAudit as {blockers?:string[]}|null)?.blockers}));
}catch(error){await client.query('ROLLBACK');throw error;}
finally{client.release();await pool.end();await closeDatabase();}
