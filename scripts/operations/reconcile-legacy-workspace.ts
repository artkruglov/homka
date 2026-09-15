/** Operator-only metadata step. Not a tool, migration, or standalone production command.
 *
 * Caller pauses every installation writer and sandbox, retires old conversations, takes a
 * tested backup, and owns BEGIN/COMMIT. preserve() must durably archive the supplied database
 * snapshot AND both old physical roots outside cleanup paths/mounts, and verify source files
 * are covered by the current root. It must throw on any failed preservation. The old roots
 * remain in place until commit; the existing cleanup worker subsequently removes only them.
 * This function never deletes files, changes audiences, rewrites input hashes, or skips cleanup.
 */
import type {PoolClient} from 'pg';

const references=['image_generation_operations','video_generation_operations','workspace_operations',
  'workspace_file_deliveries','integration_accounts','oauth_authorizations','workspace_deletion_jobs'] as const;
const movable=['image_generation_operations','video_generation_operations','workspace_operations','workspace_file_deliveries'] as const;
interface Root {
  id:string;family_id:string;owner_user_id:string|null;group_id:string|null;scope:string;space_id:string|null;
}
export interface WorkspacePreservationSnapshot {
  source:Root;target:Root;references:Record<string,unknown[]>;
}
function fail(reason:string):never {throw new Error(`AGENT_WORKSPACE_RECONCILIATION_${reason}`);}

export async function reconcileLegacyWorkspaceRecords(client:PoolClient,
  pair:{sourceId:string;targetId:string},
  preserve:(snapshot:WorkspacePreservationSnapshot)=>Promise<void>) {
  // SAVEPOINT also proves the caller started a transaction. Never commit on their behalf.
  await client.query('SAVEPOINT workspace_reconcile');
  try {
    const columns=(await client.query<{table_name:string}>(`SELECT table_name FROM information_schema.columns
      WHERE table_schema=current_schema() AND column_name='workspace_id' ORDER BY table_name`)).rows.map(r=>r.table_name);
    if(JSON.stringify(columns)!==JSON.stringify([...references].sort()))fail('SCHEMA_CHANGED');
    const links=(await client.query<{table_name:string;columns:string[]}>(`SELECT c.conrelid::regclass::text AS table_name,
      array(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(n,ord)
        JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.n ORDER BY k.ord) AS columns
      FROM pg_constraint c WHERE c.contype='f' AND c.confrelid='workspaces'::regclass`)).rows;
    for(const link of links){
      if(!references.includes(link.table_name as typeof references[number])||
        !link.columns.includes('workspace_id')||link.columns.some(c=>!['workspace_id','space_id'].includes(c)))fail('SCHEMA_CHANGED');
    }
    await client.query(`LOCK TABLE workspaces,spaces,family_space_runtime,conversation_sessions,
      ${references.join(',')} IN SHARE ROW EXCLUSIVE MODE`);
    const roots=(await client.query<Root>('SELECT * FROM workspaces WHERE id=ANY($1::uuid[]) FOR UPDATE',
      [[pair.sourceId,pair.targetId]])).rows;
    const source=roots.find(r=>r.id===pair.sourceId),target=roots.find(r=>r.id===pair.targetId);
    if(!source||!target||source.id===target.id)fail('ROOT_PAIR_MISSING');
    if(!source.space_id||target.space_id||source.family_id!==target.family_id||
      source.scope!==target.scope||source.owner_user_id!==target.owner_user_id||source.group_id!==target.group_id)fail('BOUNDARY_MISMATCH');
    const boundary=(await client.query(`SELECT 1 FROM spaces s JOIN family_space_runtime r ON r.family_id=s.family_id
      WHERE s.id=$1 AND s.family_id=$2 AND s.legacy_scope::text=$3 AND r.mode='legacy'
        AND s.owner_user_id IS NOT DISTINCT FROM $4::uuid AND s.source_group_id IS NOT DISTINCT FROM $5::uuid`,
      [source.space_id,source.family_id,source.scope,source.owner_user_id,source.group_id])).rowCount;
    if(boundary!==1)fail('BOUNDARY_MISMATCH');
    if((await client.query('SELECT 1 FROM conversation_sessions WHERE family_id=$1 AND retired_at IS NULL LIMIT 1',
      [source.family_id])).rowCount)fail('LIVE_CONVERSATION');
    const ids=[source.id,target.id];
    // Connection ciphertext/profile identity requires its own reviewed migration, not a blind FK move.
    for(const table of ['integration_accounts','oauth_authorizations','workspace_deletion_jobs']){
      if((await client.query(`SELECT 1 FROM ${table} WHERE workspace_id=ANY($1::uuid[]) LIMIT 1`,[ids])).rowCount)fail('DEPENDENT_STATE');
    }
    for(const table of ['image_generation_operations','video_generation_operations','workspace_file_deliveries']){
      if((await client.query(`SELECT 1 FROM ${table} WHERE workspace_id=ANY($1::uuid[]) AND status<>'completed' LIMIT 1`,[ids])).rowCount)fail('ACTIVE_OPERATION');
    }
    const boundTables=new Set((await client.query<{table_name:string}>(`SELECT table_name FROM information_schema.columns
      WHERE table_schema=current_schema() AND column_name='space_id'`)).rows.map(r=>r.table_name));
    for(const table of movable){
      if(!boundTables.has(table))continue;
      if((await client.query(`SELECT 1 FROM ${table} WHERE workspace_id=ANY($1::uuid[])
        AND space_id IS NOT NULL AND space_id<>$2 LIMIT 1`,[ids,source.space_id])).rowCount)fail('BOUNDARY_MISMATCH');
    }
    const snapshot:WorkspacePreservationSnapshot={source,target,references:{}};
    for(const table of references){
      snapshot.references[table]=(await client.query(`SELECT to_jsonb(t) AS value FROM ${table} t
        WHERE workspace_id=ANY($1::uuid[]) ORDER BY to_jsonb(t)::text`,[ids])).rows.map(r=>r.value);
    }
    const before:Record<string,string[]>={};
    for(const table of movable){
      before[table]=(await client.query(`SELECT (to_jsonb(t)-'workspace_id')::text AS value FROM ${table} t
        WHERE workspace_id=ANY($1::uuid[]) ORDER BY 1`,[ids])).rows.map(r=>r.value);
    }
    await preserve(structuredClone(snapshot));
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    const moved:Record<string,number>={};
    for(const table of movable){
      moved[table]=(await client.query(`UPDATE ${table} SET workspace_id=$2 WHERE workspace_id=$1`,
        [source.id,target.id])).rowCount??0;
    }
    await client.query('DELETE FROM workspaces WHERE id=$1',[source.id]);
    // Only NULL -> the same frozen legacy area. Existing immutable boundaries never change.
    await client.query('UPDATE workspaces SET space_id=$2 WHERE id=$1',[target.id,source.space_id]);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    for(const table of movable){
      const after=(await client.query(`SELECT (to_jsonb(t)-'workspace_id')::text AS value FROM ${table} t
        WHERE workspace_id=$1 ORDER BY 1`,[target.id])).rows.map(r=>r.value);
      if(JSON.stringify(after)!==JSON.stringify(before[table]))fail('RECEIPT_CHANGED');
    }
    const cleanup=(await client.query('SELECT workspace_id FROM workspace_deletion_jobs WHERE workspace_id=ANY($1::uuid[])',[ids])).rows;
    if(cleanup.length!==1||cleanup[0].workspace_id!==source.id)fail('CLEANUP_MISMATCH');
    await client.query('RELEASE SAVEPOINT workspace_reconcile');
    return {sourceId:source.id,targetId:target.id,spaceId:source.space_id,moved,cleanupPending:true};
  }catch(error){
    await client.query('ROLLBACK TO SAVEPOINT workspace_reconcile');
    await client.query('RELEASE SAVEPOINT workspace_reconcile');
    throw error;
  }
}
