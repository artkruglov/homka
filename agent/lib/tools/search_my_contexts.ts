/** Private-only root search across currently accessible memory spaces. */
import { defineTool } from "eve/tools";
import { z } from "zod";
import { requireMemoryAuthorization } from "../memory-context.js";
import { searchPersonalContexts } from "../personal-context-search.js";
import { personalContextDependencies } from "../personal-context-repository.js";

export default defineTool({
  description:'Личный обзор памяти: action=list показывает доступные контексты; action=search и query ищут по личной, семейной и доступной групповой памяти. groupRef необязательный, только из list, сужает поиск до одной группы. Участие в Telegram проверяется при каждом чтении. partial=true означает неполный результат, не утверждай, что проверены все чаты. Это сохраненная память, не все сообщения и файлы. Всегда указывай источник групповых сведений. Групповые записи из этого инструмента доступны здесь только для чтения.',
  inputSchema:z.object({action:z.enum(['list','search']),query:z.string().trim().min(1).max(2000).optional(),groupRef:z.uuid().optional()}).strict(),
  execute(input,ctx) { return searchPersonalContexts(requireMemoryAuthorization(ctx),input,personalContextDependencies); },
});
