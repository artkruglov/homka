/** Resolve transport only; callers must still reauthorize actor, workspace, grant and delivery.
 * The saved operation origin, target key and payment receipt are never rewritten.
 */
import {database} from '../database.js';
import {AppError} from '../app-error.js';
import {isAudienceProven} from '../spaces/telegram-audience-proof.js';
import {parseVideoCompletionOrigin,type VideoCompletionOrigin} from './video-completion-origin.js';

export async function resolveVideoCompletionDestination(saved:VideoCompletionOrigin):Promise<VideoCompletionOrigin>{
  const origin=parseVideoCompletionOrigin(saved);
  if(origin.authorization.groupId===null)return origin;
  const client=await database().connect();
  try{
    await client.query('BEGIN');
    const row=(await client.query<{
      family_id:string;group_id:string|null;new_chat_id:string;current_chat:string|null;
      group_type:string|null;space_id:string|null;policy_version:number|null;binding_state:string|null;
    }>(`SELECT migration.family_id,migration.group_id,migration.new_chat_id,
      registration.telegram_chat_id AS current_chat,registration.type::text AS group_type,
      binding.space_id,binding.state AS binding_state,space.policy_version
      FROM telegram_group_migrations migration
      LEFT JOIN telegram_groups registration ON registration.id=migration.group_id
      LEFT JOIN space_bindings binding ON binding.group_id=registration.id
      LEFT JOIN spaces space ON space.id=binding.space_id
      WHERE migration.old_chat_id=$1`,[origin.target.chatId])).rows[0];
    if(!row){await client.query('COMMIT');return origin;}
    if(row.family_id!==origin.authorization.familyId||row.group_id!==origin.authorization.groupId||
      row.current_chat!==row.new_chat_id||row.group_type!==origin.authorization.groupType){
      throw new AppError('AGENT_VIDEO_COMPLETION_ACCESS_REVOKED','Исходная группа видео больше не подтверждена');
    }
    if(!row.space_id||!row.policy_version||row.binding_state!=='active'||
      !await isAudienceProven(client,{groupId:row.group_id,spaceId:row.space_id,
        policyVersion:row.policy_version,now:new Date()})){
      throw new AppError('AGENT_VIDEO_MIGRATION_AUDIENCE_PENDING','Видео ожидает подтверждения состава перенесённого чата');
    }
    await client.query('COMMIT');
    return parseVideoCompletionOrigin({...origin,target:{chatId:row.new_chat_id},forumTopicId:null,
      authorization:{...origin.authorization,telegramChatType:'supergroup'}});
  }catch(error){await client.query('ROLLBACK');throw error;}
  finally{client.release();}
}
