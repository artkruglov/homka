/** Live private membership and registered group candidates for inward memory search. */
import { isCurrentTelegramMember } from "./telegram-current-membership.js";
import { AppError } from "./app-error.js";
import { database } from "./database.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { retrieveRelevantMemories } from "./memory-retrieval.js";
import type { PersonalContextDependencies } from "./personal-context-search.js";
import { parseExternalGroupToolAllowlist } from "./tool-policy/group-tool-catalog.js";

async function assertPrivate(auth: MemoryAuthorization) {
  if (auth.groupId || !auth.userId || auth.telegramActorKind!=='telegram_user' || !auth.scopes.includes('personal')) {
    throw new AppError('AGENT_PERSONAL_CONTEXT_DENIED','Обзор доступен только в личном чате');
  }
  const result=await database().query(`SELECT 1 FROM family_memberships m JOIN users u ON u.id=m.user_id
    WHERE m.family_id=$1 AND m.user_id=$2 AND u.telegram_user_id=$3`,[auth.familyId,auth.userId,auth.telegramUserId]);
  if (!result.rowCount) throw new AppError('AGENT_PERSONAL_CONTEXT_DENIED','Семейное членство больше не действует');
}
export const personalContextDependencies: PersonalContextDependencies={
  assertPrivate,
  async groups(auth,groupRef) {
    await assertPrivate(auth);
    // Registration is an application boundary, not a grant by itself. Telegram membership is
    // independently checked before any label/content is returned to the calling model.
    const result=await database().query<{id:string;title:string;telegram_chat_id:string;tool_allowlist:string[]}>(
      `SELECT id,title,telegram_chat_id,tool_allowlist FROM telegram_groups
       WHERE family_id=$1 AND type='external' AND ($2::uuid IS NULL OR id=$2) ORDER BY id`,
      [auth.familyId,groupRef??null]);
    return result.rows.filter(r=>parseExternalGroupToolAllowlist(r.tool_allowlist)?.has('search_memories'))
      .map(r=>({id:r.id,title:r.title,chatId:r.telegram_chat_id}));
  },
  member:isCurrentTelegramMember,
  async stillAllowed(auth,group) {
    await assertPrivate(auth);
    const rows=await database().query<{tool_allowlist:string[]}>(
      `SELECT tool_allowlist FROM telegram_groups WHERE id=$1 AND family_id=$2 AND telegram_chat_id=$3 AND type='external'`,
      [group.id,auth.familyId,group.chatId]);
    return parseExternalGroupToolAllowlist(rows.rows[0]?.tool_allowlist)?.has('search_memories')===true &&
      await isCurrentTelegramMember(group.chatId,auth.telegramUserId!);
  },
  search:retrieveRelevantMemories,
};
