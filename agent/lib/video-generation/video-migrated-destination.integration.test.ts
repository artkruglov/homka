import {afterAll,beforeEach,describe,it,expect} from 'vitest';
import {database,closeDatabase} from '../database.js';
import {createTwoSpaceFixture,currentSpacePolicyVersion} from '../spaces/two-space-fixture.js';
import {recordAudienceProof} from '../spaces/telegram-audience-proof.js';
import {parseVideoCompletionOrigin} from './video-completion-origin.js';
import {resolveVideoCompletionDestination} from './video-migrated-destination.js';
const enabled=process.env.RUN_DATABASE_INTEGRATION_TESTS==='true';
if(enabled&&!new URL(process.env.DATABASE_URL!).pathname.endsWith('_test'))throw Error('Unsafe database');
(enabled?describe:describe.skip)('migrated video destination',()=>{
  beforeEach(async()=>{await database().query('TRUNCATE families,users CASCADE');});
  afterAll(closeDatabase);
  it('requires fresh audience proof and preserves the immutable origin',async()=>{
    const f=await createTwoSpaceFixture('video-migration');
    const origin=parseVideoCompletionOrigin({version:1,workspaceId:f.pairSpaceId,actorTelegramId:'998',scope:'family',
      target:{chatId:f.telegramChatId},authorization:{familyId:f.familyId,userId:f.owner.userId,
        groupId:f.groupId,groupType:'family_private',role:'owner',telegramChatType:'group'}});
    await expect(resolveVideoCompletionDestination(origin)).resolves.toEqual(origin);
    await database().query("UPDATE telegram_groups SET telegram_chat_id='-100998' WHERE id=$1",[f.groupId]);
    await database().query(`INSERT INTO telegram_group_migrations(family_id,group_id,old_chat_id,new_chat_id,source_update_id)
      VALUES($1,$2,$3,'-100998',4001)`,[f.familyId,f.groupId,f.telegramChatId]);
    await expect(resolveVideoCompletionDestination(origin)).rejects.toThrow(/AGENT_VIDEO_MIGRATION_AUDIENCE_PENDING/);
    const client=await database().connect();
    try{await recordAudienceProof(client,{familyId:f.familyId,groupId:f.groupId,spaceId:f.pairSpaceId,
      policyVersion:await currentSpacePolicyVersion(f.pairSpaceId),botIsAdministrator:true,
      confirmedBy:f.owner.userId,declaredBotCount:1,observedMemberCount:3,roster:[f.owner.userId,f.spouse.userId]});}
    finally{client.release();}
    const resolved=await resolveVideoCompletionDestination(origin);
    expect(resolved.target).toEqual({chatId:'-100998'});
    expect(resolved.authorization).toEqual({...origin.authorization,telegramChatType:'supergroup'});
    expect(origin.target.chatId).toBe(f.telegramChatId);
    await database().query("UPDATE telegram_chat_audience_proofs SET checked_at=now()-interval '1 hour'");
    await expect(resolveVideoCompletionDestination(origin)).rejects.toThrow(/AGENT_VIDEO_MIGRATION_AUDIENCE_PENDING/);
    await database().query('DELETE FROM telegram_groups WHERE id=$1',[f.groupId]);
    await expect(resolveVideoCompletionDestination(origin)).rejects.toThrow(/AGENT_VIDEO_COMPLETION_ACCESS_REVOKED/);
  });
});
