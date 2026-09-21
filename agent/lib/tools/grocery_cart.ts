/**
 * Каталог продуктов и ссылка на корзину.
 *
 * Экспорт:
 * - `grocery_cart`: поиск товаров, детали одного товара и ссылка на собранную корзину.
 * - `groceryCartInput`: та же схема ввода для проверок вне Eve.
 *
 * Инструмент только читает каталог и просит источник собрать корзину. Заказ оформляет человек,
 * открыв ссылку: доступа к его аккаунту, адресу и оплате у бота нет и не предполагается.
 *
 * Запрос уходит на сторонний сервер, поэтому в него попадает только то, что человек ищет.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { AppError } from "../app-error.js";
import { requireMemoryAuthorization } from "../memory-context.js";
import { withIntegrationSpace } from "../spaces/integration-space.js";
import {
  GROCERY_CART_MAX_ITEMS,
  GROCERY_CART_MAX_QUANTITY,
  GROCERY_CART_MIN_QUANTITY,
  GROCERY_SEARCH_MAX_ITEMS,
} from "../grocery/grocery-config.js";
import { callGroceryCatalog } from "../grocery/grocery-throttle.js";
import {
  groceryCartLink,
  groceryDetails,
  groceryItems,
} from "../grocery/grocery-presentation.js";

const productId = z.number().int().positive().max(999_999_999);

export const groceryCartInput = z.object({

  action: z.enum(["search", "details", "link"]),
  items: z.array(z.object({
    productId,
    quantity: z.number().min(GROCERY_CART_MIN_QUANTITY).max(GROCERY_CART_MAX_QUANTITY),
  })).min(1).max(GROCERY_CART_MAX_ITEMS).optional(),
  page: z.number().int().min(1).max(99).optional(),
  productId: productId.optional(),
  query: z.string().trim().min(1).max(200).optional(),
  sort: z.enum(["price_asc", "price_desc", "rating", "popularity", "new"]).optional(),
}).strict().superRefine((value, ctx) => {
  const fields: Record<string, string[]> = {
    details: ["productId"],
    link: ["items"],
    search: ["query", "sort", "page"],
  };
  for (const key of Object.keys(value)) {
    if (key !== "action" && !fields[value.action]!.includes(key)) {
      ctx.addIssue({ code: "custom", message: `Недопустимое поле ${key} для ${value.action}` });
    }
  }
  if (value.action === "search" && !value.query) {
    ctx.addIssue({ code: "custom", message: "Для search нужен query" });
  }
  if (value.action === "details" && value.productId === undefined) {
    ctx.addIssue({ code: "custom", message: "Для details нужен productId из search" });
  }
  if (value.action === "link" && !value.items) {
    ctx.addIssue({ code: "custom", message: "Для link нужен items" });
  }
});

export default defineTool({
  description: [
    "Каталог продуктов ВкусВилла: search находит товары по запросу, details показывает состав и КБЖУ одного товара, link собирает ссылку на корзину.",
    "search: query обязателен; sort price_asc|price_desc|rating|popularity|new; page для следующей страницы. В выдаче productId, название, цена, единица и рейтинг.",
    "details: productId из выдачи search.",
    `link: items от одной до ${GROCERY_CART_MAX_ITEMS} позиций, каждая productId и quantity (${GROCERY_CART_MIN_QUANTITY}..${GROCERY_CART_MAX_QUANTITY}). Возвращает ссылку на корзину.`,
    "Ссылку отправь человеку целиком и скажи, что заказ он оформляет сам: адрес доставки и оплата остаются в его аккаунте ВкусВилла, у бота доступа к ним нет.",
    "Ссылка открывает предложение «С вами поделились товарами», а не подтверждает перенос в личную корзину. Объясни следующий шаг: открыть ссылку, выбрать место получения, проверить наличие и подтвердить добавление на сайте. Не утверждай, что товары уже в корзине получателя; если их не видно, не создавай новую ссылку автоматически.",
    "Цены и наличие приходят со стороннего сервера и могут измениться к моменту заказа; не обещай итоговую сумму.",
  ].join(" "),
  inputSchema: groceryCartInput,
  async execute(input,ctx) {
    return withIntegrationSpace(requireMemoryAuthorization(ctx),async()=>{
    if (input.action === "search") {
      const result = await callGroceryCatalog("vkusvill_products_search", {
        mode: "short", page: input.page ?? 1, q: input.query!, sort: input.sort ?? "popularity",
      });
      return groceryItems(result, GROCERY_SEARCH_MAX_ITEMS);
    }
    if (input.action === "details") {
      return groceryDetails(await callGroceryCatalog("vkusvill_product_details", {
        id: input.productId!,
      }));
    }
    // Один товар дважды в одной корзине источник принимает как две позиции: складываем сами.
    const merged = new Map<number, number>();
    for (const item of input.items!) {
      merged.set(item.productId, (merged.get(item.productId) ?? 0) + item.quantity);
    }
    if (merged.size > GROCERY_CART_MAX_ITEMS) {
      throw new AppError(
        "AGENT_GROCERY_CART_TOO_LARGE",
        `В одну ссылку помещается не больше ${GROCERY_CART_MAX_ITEMS} позиций`,
      );
    }
    const products = [...merged].map(([id, quantity]) => {
      if (quantity > GROCERY_CART_MAX_QUANTITY) {
        throw new AppError(
          "AGENT_GROCERY_QUANTITY_TOO_LARGE",
          `Общее количество одного товара превышает ${GROCERY_CART_MAX_QUANTITY}. Уточните количество`,
        );
      }
      return { q: Number(quantity.toFixed(2)), xml_id: id };
    });
    return {
      link: groceryCartLink(await callGroceryCatalog("vkusvill_cart_link_create", { products })),
      positions: products.length,
    };
    });
  },
});
