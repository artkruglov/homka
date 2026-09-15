import {afterAll,beforeEach,describe,it,expect} from 'vitest';
import {database,closeDatabase} from '../database.js';
import {parseVideoCompletionOrigin,type VideoCompletionOrigin} from './video-completion-origin.js';
import {authorizeVideoCompletionOrigin} from './video-completion-access.js';
const enabled=process.env.RUN_DATABASE_INTEGRATION_TESTS==='true';
if(enabled&&!new URL(process.env.DATABASE_URL!).pathname.endsWith('_test'))throw Error('Unsafe database');
let origin:VideoCompletionOrigin;
(enabled?describe:describe.skip)('live video completion authority',()=>{
  beforeEach(async()=>{
    await database().query('TRUNCATE families,users CASCADE');
    const family=(await database().query("INSERT INTO families(name) VALUES('Video test') RETURNING id")).rows[0].id;
    const user=(await database().query("INSERT INTO users(telegram_user_id,display_name) VALUES('998','Video author') RETURNING id")).rows[0].id;
    await database().query("INSERT INTO family_memberships(family_id,user_id,role) VALUES($1,$2,'owner')",[family,user]);
    origin=parseVideoCompletionOrigin({version:1,workspaceId:family,actorTelegramId:'998',scope:'personal',target:{chatId:'998'},
      authorization:{familyId:family,userId:user,role:'owner',groupId:null,groupType:null,telegramChatType:'private'}});
  });
  afterAll(closeDatabase);
  it('checks the current author identity and membership again',async()=>{
    await authorizeVideoCompletionOrigin(origin);
    await database().query('DELETE FROM family_memberships');
    await expect(authorizeVideoCompletionOrigin(origin)).rejects.toMatchObject({code:'AGENT_VIDEO_COMPLETION_ACCESS_REVOKED'});
  });
  it('does not trust a saved user id after its Telegram identity changed',async()=>{
    await database().query("UPDATE users SET telegram_user_id='999'");
    await expect(authorizeVideoCompletionOrigin(origin)).rejects.toMatchObject({code:'AGENT_VIDEO_COMPLETION_ACCESS_REVOKED'});
  });
  it('does not upgrade an old context after switching to spaces',async()=>{
    await database().query("UPDATE family_space_runtime SET mode='spaces'");
    await expect(authorizeVideoCompletionOrigin(origin)).rejects.toMatchObject({code:'AGENT_SPACE_CONTEXT_REQUIRED'});
  });
  it('uses space write rights and refuses a stale policy or a child role',async()=>{
    const auth=origin.authorization;
    const space=(await database().query("INSERT INTO spaces(family_id,kind,title,owner_user_id) VALUES($1,'personal','Video space',$2) RETURNING id",
      [auth.familyId,auth.userId])).rows[0].id;
    await database().query("INSERT INTO space_memberships(family_id,space_id,user_id,role,state) VALUES($1,$2,$3,'adult','active')",
      [auth.familyId,space,auth.userId]);
    await database().query("UPDATE spaces SET state='active' WHERE id=$1",[space]);
    const version=async()=>Number((await database().query('SELECT policy_version FROM spaces WHERE id=$1',[space])).rows[0].policy_version);
    origin={...origin,authorization:{...auth,space:{spaceId:space,policyVersion:await version()}}};
    await authorizeVideoCompletionOrigin(origin);
    await database().query("UPDATE spaces SET policy_version=policy_version+1 WHERE id=$1",[space]);
    await expect(authorizeVideoCompletionOrigin(origin)).rejects.toMatchObject({code:'AGENT_SPACE_CONTEXT_STALE'});
    await database().query("UPDATE space_memberships SET role='child' WHERE space_id=$1",[space]);
    origin.authorization.space!.policyVersion=await version();
    await expect(authorizeVideoCompletionOrigin(origin)).rejects.toMatchObject({code:'AGENT_SPACE_ACCESS_DENIED'});
  });
  it('requires the original group, exact Telegram destination and current video grant',async()=>{
    const group=(await database().query(`INSERT INTO telegram_groups(family_id,telegram_chat_id,title,type,message_mode,tool_allowlist)
      VALUES($1,'-998','Video group','external','addressed_only',ARRAY['generate_video']) RETURNING id`,[origin.authorization.familyId])).rows[0].id;
    origin=parseVideoCompletionOrigin({...origin,scope:'group',target:{chatId:'-998'},authorization:{...origin.authorization,
      role:'external',userId:null,groupId:group,groupType:'external',telegramChatType:'group'}});
    await authorizeVideoCompletionOrigin(origin);
    await database().query("UPDATE telegram_groups SET tool_allowlist='{}'");
    await expect(authorizeVideoCompletionOrigin(origin)).rejects.toMatchObject({code:'AGENT_GROUP_TOOL_FORBIDDEN'});
    await database().query("UPDATE telegram_groups SET tool_allowlist=ARRAY['generate_video'],telegram_chat_id='-999'");
    await expect(authorizeVideoCompletionOrigin(origin)).rejects.toMatchObject({code:'AGENT_VIDEO_COMPLETION_ACCESS_REVOKED'});
  });
});
