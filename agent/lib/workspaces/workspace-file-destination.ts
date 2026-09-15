/** A readable workspace does not authorize sending its file to a different Telegram destination. */
import {database} from '../database.js';
import {AppError} from '../app-error.js';
import type {WorkspaceAuthorization} from './workspace-repository.js';

export async function requireWorkspaceFileDestination(auth:WorkspaceAuthorization,chatId:string):Promise<void>{
  const result=auth.telegramChatType==='private'&&auth.groupId===null&&auth.groupType===null
    ? await database().query('SELECT 1 FROM users WHERE id=$1 AND telegram_user_id=$2',[auth.userId,chatId])
    : auth.telegramChatType!=='private'&&auth.groupId!==null
      ? await database().query(`SELECT 1 FROM telegram_groups
          WHERE id=$1 AND family_id=$2 AND type::text=$3 AND telegram_chat_id=$4`,
        [auth.groupId,auth.familyId,auth.groupType,chatId])
      : null;
  if(result?.rowCount!==1)throw new AppError('AGENT_WORKSPACE_FILE_DESTINATION_CHANGED',
    'Адрес чата для файла больше не подтверждён. Запросите отправку в текущем чате');
}
