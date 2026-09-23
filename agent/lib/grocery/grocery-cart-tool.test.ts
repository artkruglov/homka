/**
 * Инструмент каталога: поля действия не перепутываются, корзина не превышает предел источника,
 * а повтор одного товара складывается, а не удваивает позицию.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const call = vi.hoisted(() => vi.fn());
const gate=vi.hoisted(()=>vi.fn(async (_auth:unknown,operation:()=>Promise<unknown>)=>operation()));
vi.mock("../memory-context.js",()=>({requireMemoryAuthorization:()=>({role:"member"})}));
vi.mock("../spaces/integration-space.js",()=>({withIntegrationSpace:gate}));
vi.mock("../grocery/grocery-mcp-client.js", () => ({ callGroceryTool: call }));

import groceryCart, { groceryCartInput } from "../tools/grocery_cart.js";

const context = {} as never;

function run(input: unknown) {
  const parsed = groceryCartInput.safeParse(input);
  if (!parsed.success) throw new Error("AGENT_TEST_INPUT_REJECTED");
  return groceryCart.execute(parsed.data as never, context);
}

describe("grocery cart tool", () => {
  beforeEach(() => vi.clearAllMocks());
  it("does not contact the catalog when the space refuses integrations",async()=>{
    gate.mockRejectedValueOnce(new Error("AGENT_SPACE_ACCESS_DENIED"));
    await expect(run({action:"search",query:"Молоко"})).rejects.toThrow("AGENT_SPACE_ACCESS_DENIED");
    expect(call).not.toHaveBeenCalled();
  });

  it("refuses a field that belongs to another action", () => {
    expect(groceryCartInput.safeParse({ action: "search", productId: 1 }).success).toBe(false);
    expect(groceryCartInput.safeParse({ action: "details" }).success).toBe(false);
    expect(groceryCartInput.safeParse({ action: "link", items: [] }).success).toBe(false);
    expect(groceryCartInput.safeParse({
      action: "link", items: Array.from({ length: 21 }, () => ({ productId: 1, quantity: 1 })),
    }).success).toBe(false);
  });

  it("adds up one product asked for twice instead of sending two positions", async () => {
    call.mockResolvedValue({ data: { link: "https://vkusvill.ru/?share_basket=1" }, ok: true });

    await expect(run({
      action: "link",
      items: [{ productId: 27695, quantity: 2 }, { productId: 27695, quantity: 1 }],
    })).resolves.toEqual({ link: "https://vkusvill.ru/?share_basket=1", positions: 1 });
    expect(call).toHaveBeenCalledWith("vkusvill_cart_link_create", {
      products: [{ q: 3, xml_id: 27695 }],
    });
  });

  it("asks the catalog for the short field set and returns only the chosen fields", async () => {
    call.mockResolvedValue({
      data: { items: [{ xml_id: 1, name: "Творог", price: { current: 108 }, unit: "шт" }] },
      ok: true,
    });

    await expect(run({ action: "search", query: "творог" })).resolves.toEqual({
      items: [{ name: "Творог", price: 108, productId: 1, rating: null, unit: "шт", url: null }],
      total: null,
    });
    expect(call).toHaveBeenCalledWith("vkusvill_products_search", {
      mode: "short", page: 1, q: "творог", sort: "popularity",
    });
  });

  it("looks up a whole shopping list in one call instead of one call per item", async () => {
    // 22 сентября 2026 список из тринадцати позиций стал тринадцатью вызовами подряд.
    call.mockImplementation(async (_tool: string, args: { q: string }) => ({
      data: { items: [{ name: args.q, price: { current: 100 }, unit: "шт", xml_id: 1 }] },
      ok: true,
    }));

    const found = await run({ action: "search", queries: ["молоко", "хлеб", "сыр"] }) as {
      found: { items: { items: { name: string }[] }; query: string }[];
    };

    expect(found.found.map((entry) => entry.query)).toEqual(["молоко", "хлеб", "сыр"]);
    expect(found.found[0]!.items.items[0]!.name).toBe("молоко");
    expect(call).toHaveBeenCalledTimes(3);
    // Пакет и одиночный запрос вместе не принимаются, страница только у одиночного.
    expect(groceryCartInput.safeParse({ action: "search", queries: ["хлеб"], query: "сыр" }).success).toBe(false);
    expect(groceryCartInput.safeParse({ action: "search", queries: ["хлеб"], page: 2 }).success).toBe(false);
  });

  it("rejects a merged quantity above the limit without creating a smaller basket", async () => {
    await expect(run({
      action: "link",
      items: [{ productId: 27695, quantity: 30 }, { productId: 27695, quantity: 20 }],
    })).rejects.toMatchObject({ code: "AGENT_GROCERY_QUANTITY_TOO_LARGE" });
    expect(call).not.toHaveBeenCalled();
  });
});
