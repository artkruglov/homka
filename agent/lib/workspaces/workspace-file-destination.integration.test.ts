import {afterAll,beforeEach,describe,it,expect} from 'vitest';
import {database,closeDatabase} from '../database.js';
import type {WorkspaceAuthorization} from './workspace-repository.js';
import {requireWorkspaceFileDestination} from './workspace-file-destination.js';
const enabled=process.env.RUN_DATABASE_INTEGRATION_TESTS==='true';
if(enabled&&!new URL(process.env.DATABASE_URL!).pathname.endsWith('_test'))throw Error('Unsafe database');
(enabled?describe:describe.skip)('workspace delivery destination',()=>{
  let auth:WorkspaceAuthorization;
  beforeEach(async()=>{
    await database().query('TRUNCATE families,users CASCADE');
    const family=(await database().query("INSERT INTO families(name) VALUES('Destination') RETURNING id")).rows[0].id;
    const user=(await database().query("INSERT INTO users(telegram_user_id,display_name) VALUES('998','Owner') RETURNING id")).rows[0].id;
    const group=(await database().query(`INSERT INTO telegram_groups(family_id,telegram_chat_id,title,type,message_mode)
      VALUES($1,'-998','Group','family_private','all') RETURNING id`,[family])).rows[0].id;
    auth={familyId:family,userId:user,groupId:group,groupType:'family_private',role:'owner',telegramChatType:'group'};
  });
  afterAll(closeDatabase);
  it('requires the current group address, family and trust zone',async()=>{
    await requireWorkspaceFileDestination(auth,'-998');
    await expect(requireWorkspaceFileDestination(auth,'-999')).rejects.toThrow(/DESTINATION_CHANGED/);
    await database().query("UPDATE telegram_groups SET telegram_chat_id='-100998' WHERE id=$1",[auth.groupId]);
    await expect(requireWorkspaceFileDestination(auth,'-998')).rejects.toThrow(/DESTINATION_CHANGED/);
    await requireWorkspaceFileDestination({...auth,telegramChatType:'supergroup'},'-100998');
    await expect(requireWorkspaceFileDestination({...auth,groupType:'external'},'-100998')).rejects.toThrow(/DESTINATION_CHANGED/);
  });
  it('never sends a personal file to another person or a group',async()=>{
    const personal={...auth,groupId:null,groupType:null,telegramChatType:'private' as const};
    await requireWorkspaceFileDestination(personal,'998');
    await expect(requireWorkspaceFileDestination(personal,'999')).rejects.toThrow(/DESTINATION_CHANGED/);
    await expect(requireWorkspaceFileDestination(personal,'-998')).rejects.toThrow(/DESTINATION_CHANGED/);
    await expect(requireWorkspaceFileDestination({...personal,userId:null},'998')).rejects.toThrow(/DESTINATION_CHANGED/);
  });
});
