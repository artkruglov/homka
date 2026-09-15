/**
 * Ответ каталога это недоверенные данные с чужого сервера: он приходит с HTML в названиях, с
 * составом и КБЖУ по каждому товару и может оказаться любым. Проверяется приведение к коротким
 * полям, отказ от непонятного ответа и проверка адреса ссылки на корзину.
 */
import { describe, expect, it } from "vitest";

import {
  groceryCartLink,
  groceryDetails,
  groceryItems,
} from "./grocery-presentation.js";

const item = {
  id: 27695,
  name: "Творог 5%,&nbsp;180&nbsp;г",
  price: { currency: "RUB", current: 108, old: null },
  properties: [
    { name: "Пищевая ценность", value: "белки 16 г<br>жиры 5 г" },
    { name: "", value: "пустое имя выбрасывается" },
  ],
  rating: { average: 4.9, count: 55_100 },
  unit: "шт",
  url: "https://vkusvill.ru/goods/tvorog-5-27695/",
  xml_id: 27695,
};

describe("grocery presentation", () => {
  it("keeps only the fields a person chooses by", () => {
    const shaped = groceryItems({ data: { items: [item], meta: { total: 167 } }, ok: true }, 10);

    expect(shaped).toEqual({
      items: [{
        name: "Творог 5%, 180 г",
        price: 108,
        productId: 27695,
        rating: 4.9,
        unit: "шт",
        url: "https://vkusvill.ru/goods/tvorog-5-27695/",
      }],
      total: 167,
    });
  });

  it("drops a row without a usable identity or name instead of inventing one", () => {
    const shaped = groceryItems({
      data: { items: [{ name: "Без id" }, { xml_id: 0, name: "Нулевой id" }, item] },
      ok: true,
    }, 10);

    expect(shaped.items.map((row) => row.productId)).toEqual([27695]);
  });

  it("refuses an answer that does not say it succeeded", () => {
    for (const answer of [null, {}, { ok: false, data: {} }, { ok: true }]) {
      expect(() => groceryItems(answer, 10)).toThrowError(/AGENT_GROCERY_RESPONSE_INVALID/);
    }
  });

  it("returns details with markup stripped and empty properties removed", () => {
    const details = groceryDetails({ data: { items: [item] }, ok: true });

    expect(details.properties).toEqual([
      { name: "Пищевая ценность", value: "белки 16 г; жиры 5 г" },
    ]);
  });

  it("accepts only a cart link of the catalog itself", () => {
    expect(groceryCartLink({ data: { link: "https://vkusvill.ru/?share_basket=2499959943" }, ok: true }))
      .toBe("https://vkusvill.ru/?share_basket=2499959943");
    expect(groceryCartLink({data:{link:"https://www.vkusvill.ru/?share_basket=1&source=a%2Fb"},ok:true}))
      .toBe("https://www.vkusvill.ru/?share_basket=1&source=a%2Fb");
    for (const link of ["http://vkusvill.ru/x", "https://evil.example/?share_basket=1",
      "https://evilvkusvill.ru/?share_basket=1", "https:vkusvill.ru/", "https://vkusvill.ru.evil.example/",
      "https://user:password@vkusvill.ru/", "https://vkusvill.ru:8443/",
      "https://vkusvill.ru/\n", "https://vkusvill.ru\\@evil.example/", 42, null]) {
      expect(() => groceryCartLink({ data: { link }, ok: true }))
        .toThrowError(/AGENT_GROCERY_CART_LINK_INVALID/);
    }
  });
});
