import {expect,it} from 'vitest';
import {parseVideoCompletionOrigin} from './video-completion-origin.js';
const id='12345678-1234-4234-8234-123456789abc';
const origin={version:1,workspaceId:id,actorTelegramId:'998',scope:'personal',target:{chatId:'998'},
  authorization:{familyId:id,userId:id,groupId:null,groupType:null,role:'owner',telegramChatType:'private'}};
it('keeps exact backend identity and destination, rejecting extra or malformed fields',()=>{
  expect(parseVideoCompletionOrigin(origin)).toEqual(origin);
  expect(()=>parseVideoCompletionOrigin({...origin,apiKey:'must not be persisted'})).toThrow('ORIGIN_INVALID');
  expect(()=>parseVideoCompletionOrigin({...origin,workspaceId:'wrong'})).toThrow('ORIGIN_INVALID');
});
it('refuses an origin which substitutes a destination or scope',()=>{
  expect(()=>parseVideoCompletionOrigin({...origin,target:{chatId:'999'}})).toThrow('ORIGIN_INVALID');
  expect(()=>parseVideoCompletionOrigin({...origin,scope:'group'})).toThrow('ORIGIN_INVALID');
  expect(()=>parseVideoCompletionOrigin({...origin,target:{chatId:'998',messageThreadId:1}})).toThrow('ORIGIN_INVALID');
});
it('preserves a precise external group topic without assigning a family identity',()=>{
  const external={...origin,scope:'group',target:{chatId:'-100123',messageThreadId:7},
    authorization:{...origin.authorization,role:'external',userId:null,groupId:id,groupType:'external',telegramChatType:'supergroup'}};
  expect(parseVideoCompletionOrigin(external)).toEqual(external);
  expect(()=>parseVideoCompletionOrigin({...external,authorization:{...external.authorization,role:'owner'}})).toThrow('ORIGIN_INVALID');
});

it('does not confuse an ordinary reply branch with a proven forum topic',()=>{
  const group={...origin,scope:'family',target:{chatId:'-998',messageThreadId:42},forumTopicId:null,
    authorization:{...origin.authorization,groupId:id,groupType:'family_private',telegramChatType:'supergroup'}};
  expect(parseVideoCompletionOrigin(group).forumTopicId).toBeNull();
  expect(parseVideoCompletionOrigin({...group,forumTopicId:'42'}).forumTopicId).toBe('42');
  expect(()=>parseVideoCompletionOrigin({...group,forumTopicId:'43'})).toThrow('ORIGIN_INVALID');
});
