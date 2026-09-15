/**
 * Список покупок семьи.
 *
 * Экспорт:
 * - `manage_shopping_list`: добавить пункт, показать список, отметить покупку и снять отметку.
 */
import { defineTool } from "eve/tools";

import { requireMemoryAuthorization } from "../memory-context.js";
import { shoppingInput, shoppingRepository } from "../shopping/shopping-repository.js";

export default defineTool({
  description: [
    "Список покупок: add добавляет пункт, list показывает, buy отмечает купленным, unbuy снимает отметку, remove убирает пункт.",
    "add: listName и title обязательны; quantity свободным текстом (2 пачки, 500 г), note для уточнения. Исполнителя у пункта нет: покупает тот, кто дошёл до магазина.",
    "list: listName ограничивает одним списком, view open|bought|all, по умолчанию open. В ответе id, version, кто добавил и кто купил.",
    "buy, unbuy, remove: id и актуальная version из list. Если version устарела, прочитай список заново и не угадывай.",
    "Одинаковые названия не объединяются: два пакета молока в списке это намеренно два пункта.",
    "Список принадлежит области текущего разговора и виден всем её участникам.",
  ].join(" "),
  inputSchema: shoppingInput,
  async execute(input, ctx) {
    return await shoppingRepository.execute(
      requireMemoryAuthorization(ctx), input, `${ctx.session.id}:${ctx.callId}`,
    );
  },
});
