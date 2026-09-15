/** Revalidate the saved author's database identity and original conversation policy.
 * This is one completion boundary, not a delivery permission: callers also verify the queue
 * lease, operation owner, resolved workspace and current Telegram membership/audience.
 */
import {database} from '../database.js';
import {AppError} from '../app-error.js';
import {authorizeSpaceAction} from '../spaces/space-access.js';
import {readFamilySpaceMode} from '../spaces/family-space-mode.js';
import {parseExternalGroupToolAllowlist} from '../tool-policy/group-tool-catalog.js';
import {parseVideoCompletionOrigin,type VideoCompletionOrigin} from './video-completion-origin.js';

function revoked():never{
  throw new AppError('AGENT_VIDEO_COMPLETION_ACCESS_REVOKED','Доступ к исходному чату видео отозван. Автодоставка остановлена');
}
export async function authorizeVideoCompletionOrigin(saved:VideoCompletionOrigin):Promise<void>{
  const origin=parseVideoCompletionOrigin(saved);
  const auth=origin.authorization;
  const client=await database().connect();
  try{
    await client.query('BEGIN');
    if(auth.userId!==null){
      const member=await client.query(`SELECT 1 FROM family_memberships m JOIN users u ON u.id=m.user_id
        WHERE m.family_id=$1 AND m.user_id=$2 AND u.telegram_user_id=$3 AND m.role::text=$4 FOR SHARE OF m,u`,
        [auth.familyId,auth.userId,origin.actorTelegramId,auth.role]);
      if(member.rowCount!==1)revoked();
    }
    if(auth.groupId!==null){
      const group=(await client.query<{tool_allowlist:string[]}>(`SELECT tool_allowlist FROM telegram_groups
        WHERE id=$1 AND family_id=$2 AND telegram_chat_id=$3 AND type::text=$4 FOR SHARE`,
        [auth.groupId,auth.familyId,origin.target.chatId,auth.groupType])).rows[0];
      if(!group)revoked();
      if(auth.groupType==='external'&&!parseExternalGroupToolAllowlist(group.tool_allowlist)?.has('generate_video')){
        throw new AppError('AGENT_GROUP_TOOL_FORBIDDEN','Создание и доставка видео больше не разрешены в этой группе');
      }
    }
    if(!auth.space&&await readFamilySpaceMode(client,auth.familyId)==='spaces'){
      throw new AppError('AGENT_SPACE_CONTEXT_REQUIRED','Область исходного видеозадания больше не подтверждена');
    }
    if(auth.space){
      await authorizeSpaceAction(client,{
        familyId:auth.familyId,userId:auth.userId,...auth.space,
        chat:auth.groupId===null?{type:'private'}:
          {type:auth.telegramChatType==='group'?'group':'supergroup',groupId:auth.groupId},
      },'write');
    }
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}
  finally{client.release();}
}
