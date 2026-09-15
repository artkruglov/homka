/** Read-only inward search; private caller rights never propagate into a group turn. */
import { AppError } from "./app-error.js";
import type { MemoryAuthorization } from "./memory-context.js";
import type { retrieveRelevantMemories } from "./memory-retrieval.js";

export interface PersonalContextGroup { id: string; title: string; chatId: string }
export interface PersonalContextDependencies {
  assertPrivate(auth: MemoryAuthorization): Promise<void>;
  groups(auth: MemoryAuthorization, groupRef?: string): Promise<PersonalContextGroup[]>;
  member(chatId: string, telegramUserId: string): Promise<boolean>;
  stillAllowed(auth: MemoryAuthorization, group: PersonalContextGroup): Promise<boolean>;
  search: typeof retrieveRelevantMemories;
}
export async function searchPersonalContexts(auth: MemoryAuthorization,
  input: {action:'list'|'search';query?:string;groupRef?:string}, d: PersonalContextDependencies) {
  if (auth.groupId || !auth.userId || !auth.scopes.includes('personal') || auth.role==='external' ||
    auth.telegramActorKind!=='telegram_user' || !auth.telegramUserId || auth.telegramActorId!==auth.telegramUserId) {
    throw new AppError('AGENT_PERSONAL_CONTEXT_DENIED','Общий обзор доступен только в вашем личном чате');
  }
  if (input.action==='search' && !input.query?.trim()) throw new AppError('AGENT_PERSONAL_CONTEXT_QUERY_REQUIRED','Укажите вопрос для поиска');
  await d.assertPrivate(auth);
  const groups=await d.groups(auth,input.groupRef);
  const contexts: Array<{name:string;groupRef:string|null;memories?:Awaited<ReturnType<typeof retrieveRelevantMemories>>}> = [];
  if (!input.groupRef) contexts.push({name:'Личное и семья',groupRef:null,
    ...(input.action==='search'?{memories:await d.search(auth,input.query!)}:{})});
  let unavailable=0;
  for (const group of groups.slice(0,10)) {
    if (!await d.member(group.chatId,auth.telegramUserId)) { unavailable++; continue; }
    const groupAuth: MemoryAuthorization={...auth,groupId:group.id,scopes:['group']};
    const memories=input.action==='search'?await d.search(groupAuth,input.query!):undefined;
    // A concurrent local revocation must not release already fetched data into the model context.
    if (!await d.stillAllowed(auth,group)) { unavailable++; continue; }
    contexts.push({name:group.title,groupRef:group.id,...(memories?{memories}:{})});
  }
  await d.assertPrivate(auth);
  return {contexts,partial:groups.length>10 || unavailable>0,
    note:'Это поиск сохраненной памяти, не полный архив переписки и не доступ к файлам. Недоступные группы не включены.'};
}
