/** Atomic metadata phase shared by rehearsal and a quiesced installation operator.
 * Caller owns the connected client (not a transaction), writer/sandbox shutdown, verified
 * backups, physical preservation, and post-commit cleanup. This does not switch runtime mode.
 */
import type {PoolClient} from 'pg';
import {prepareSpacesCutover} from '../../agent/lib/spaces/spaces-cutover.ts';
import {reconcileLegacyWorkspaceRecords,type WorkspacePreservationSnapshot} from './reconcile-legacy-workspace.ts';

export interface WorkspacePair {sourceId:string;targetId:string}

export async function reconcileWorkspaceInstallation(client:PoolClient,pairs:readonly WorkspacePair[],
  preserve:(snapshot:WorkspacePreservationSnapshot)=>Promise<void>,
  options:{rollbackOnly?:boolean;reason:string}) {
  if(!pairs.length||new Set(pairs.flatMap(p=>[p.sourceId,p.targetId])).size!==pairs.length*2){
    throw Error('AGENT_WORKSPACE_RECONCILIATION_PAIR_SET_INVALID');
  }
  await client.query('BEGIN');
  try{
    await client.query('LOCK TABLE workspaces IN SHARE ROW EXCLUSIVE MODE');
    const actual=(await client.query<{source_id:string;target_id:string;family_id:string}>(`SELECT
      old.id source_id,new.id target_id,old.family_id FROM workspaces old JOIN workspaces new
      ON old.family_id=new.family_id AND old.scope=new.scope
      AND old.owner_user_id IS NOT DISTINCT FROM new.owner_user_id
      AND old.group_id IS NOT DISTINCT FROM new.group_id
      WHERE old.space_id IS NOT NULL AND new.space_id IS NULL ORDER BY old.id`)).rows;
    const key=(p:WorkspacePair)=>`${p.sourceId}:${p.targetId}`;
    if(JSON.stringify(pairs.map(key).sort())!==JSON.stringify(actual.map(p=>`${p.source_id}:${p.target_id}`).sort())){
      throw Error('AGENT_WORKSPACE_RECONCILIATION_PAIR_SET_CHANGED');
    }
    if((await client.query('SELECT 1 FROM workspace_deletion_jobs LIMIT 1')).rowCount){
      throw Error('AGENT_WORKSPACE_RECONCILIATION_EXISTING_CLEANUP');
    }
    for(const familyId of new Set(actual.map(p=>p.family_id))){
      await prepareSpacesCutover(client,{familyId,changedBy:null,now:new Date(),reason:options.reason});
    }
    const moved=[];
    for(const pair of pairs)moved.push(await reconcileLegacyWorkspaceRecords(client,pair,preserve));
    await client.query(options.rollbackOnly?'ROLLBACK':'COMMIT');
    return {committed:!options.rollbackOnly,moved};
  }catch(error){
    // A lost COMMIT response remains ambiguous. The caller must inspect actual state and
    // durable snapshots; it must never rerun automatically or restore an older live DB.
    await client.query('ROLLBACK');
    throw error;
  }
}
