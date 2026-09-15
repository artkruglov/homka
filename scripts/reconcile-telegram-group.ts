/** Backend operator entrypoint. Production calls only through the stopped-installation wrapper. */
import {parseArgs} from 'node:util';
import {reconcileVerifiedGroupMigration} from '../agent/lib/telegram-group-migration/reconcile.ts';
import {closeDatabase} from '../agent/lib/database.ts';
import {isAppError} from '../agent/lib/app-error.ts';

try{
  const {values}=parseArgs({options:{'update-id':{type:'string'},execute:{type:'boolean'}},strict:true});
  if(!values.execute||!values['update-id']||process.env.OSINARA_OPERATOR_WRITERS_STOPPED!=='true'){
    throw Error('AGENT_TELEGRAM_GROUP_MIGRATION_OPERATOR_REQUIRED');
  }
  const result=await reconcileVerifiedGroupMigration(values['update-id']);
  process.stdout.write(JSON.stringify({groupMigrationCommitted:true,...result})+'\n');
}catch(error){
  process.stderr.write(JSON.stringify({code:isAppError(error)?error.code:'AGENT_TELEGRAM_GROUP_MIGRATION_OPERATOR_FAILED'})+'\n');
  process.exitCode=1;
}finally{await closeDatabase();}
