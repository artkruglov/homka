/** Called in the owner-confirmed audience transaction, after the proof's policy version refresh. */
import type {PoolClient} from 'pg';
import {isAudienceProven} from '../spaces/telegram-audience-proof.js';

export async function resumeMigratedGroupJobs(client:PoolClient,familyId:string,groupId:string):Promise<void>{
  const boundary=(await client.query<{space_id:string;policy_version:number;telegram_chat_id:string}>(`
    SELECT binding.space_id,space.policy_version,registration.telegram_chat_id
    FROM telegram_groups registration JOIN space_bindings binding ON binding.group_id=registration.id
    JOIN spaces space ON space.id=binding.space_id
    JOIN telegram_group_migrations migration ON migration.group_id=registration.id
      AND migration.family_id=registration.family_id AND migration.new_chat_id=registration.telegram_chat_id
    WHERE registration.id=$1 AND registration.family_id=$2 AND binding.state='active'`,[groupId,familyId])).rows[0];
  if(!boundary||!await isAudienceProven(client,{groupId,spaceId:boundary.space_id,
    policyVersion:boundary.policy_version,now:new Date()}))return;
  const counts:Record<string,number>={};
  for(const table of ['reminders','agent_schedules'] as const){
    const result=await client.query(`UPDATE ${table} SET status='active',last_error_code=NULL,updated_at=now()
      WHERE family_id=$1 AND group_id=$2 AND telegram_chat_id=$3 AND status='paused'
        AND last_error_code='AGENT_TELEGRAM_GROUP_MIGRATED'
        AND (space_id IS NULL OR space_id=$4)`,[familyId,groupId,boundary.telegram_chat_id,boundary.space_id]);
    counts[table]=result.rowCount??0;
  }
  // Keep due times, recurrence anchors and counters. The regular dispatchers retain quiet hours,
  // task completion checks and their existing missed-occurrence policy; no second delivery path.
  if(Object.values(counts).some(Boolean))await client.query(`INSERT INTO audit_events(family_id,event_type,subject_id,metadata)
    VALUES($1,'telegram.group_migration_jobs_resumed',$2,$3::jsonb)`,[familyId,groupId,JSON.stringify(counts)]);
}
