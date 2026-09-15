/**
 * Один вызов на запрос и никаких повторов: ссылка на корзину создаётся у источника, и второй
 * вызов создал бы вторую корзину. Любая неясность источника это отказ с понятным кодом.
 */
import { describe, expect, it, vi } from "vitest";

import { createGroceryClient } from "./grocery-mcp-client.js";

function client(response: unknown, ok = true) {
  const call = vi.fn().mockResolvedValue({
    json: async () => response,
    ok,
    status: ok ? 200 : 503,
  });
  return {
    call,
    grocery: createGroceryClient({
      fetch: call as unknown as typeof fetch,
      timeoutMilliseconds: 1_000,
      url: "https://mcp.example/mcp",
    }),
  };
}

const answer = { result: { content: [{ text: '{"ok":true,"data":{"link":"x"}}', type: "text" }] } };

describe("grocery catalog client", () => {
  it("recognizes a rate limit inside an HTTP-success MCP payload without retrying", async () => {
    const {call, grocery} = client({result:{content:[{text:JSON.stringify({
      ok:false, code:'rate_limited', error:{http_status:429},
    })}]}});
    await expect(grocery('vkusvill_products_search',{q:'молоко'}))
      .rejects.toMatchObject({code:'AGENT_GROCERY_RATE_LIMITED'});
    expect(call).toHaveBeenCalledOnce();
  });
  it("sends one JSON-RPC call and returns the parsed payload", async () => {
    const { call, grocery } = client(answer);

    await expect(grocery("vkusvill_cart_link_create", { products: [] }))
      .resolves.toEqual({ data: { link: "x" }, ok: true });
    expect(call).toHaveBeenCalledOnce();
    const body = JSON.parse((call.mock.calls[0]![1] as { body: string }).body);
    expect(body).toMatchObject({
      jsonrpc: "2.0", method: "tools/call",
      params: { arguments: { products: [] }, name: "vkusvill_cart_link_create" },
    });
  });

  it("never retries and names every unclear answer with one code", async () => {
    for (const [response, ok] of [
      [answer, false],
      [{ error: { message: "boom" } }, true],
      [{ result: { content: [], isError: true } }, true],
      [{ result: { content: [] } }, true],
    ] as const) {
      const { call, grocery } = client(response, ok);
      await expect(grocery("vkusvill_products_search", { q: "творог" }))
        .rejects.toThrowError(/AGENT_GROCERY_UNAVAILABLE/);
      expect(call).toHaveBeenCalledOnce();
    }
  });

  it("reports a non-JSON tool payload separately from an unavailable source", async () => {
    const { grocery } = client({ result: { content: [{ text: "не json", type: "text" }] } });

    await expect(grocery("vkusvill_products_search", { q: "творог" }))
      .rejects.toThrowError(/AGENT_GROCERY_RESPONSE_INVALID/);
  });
});
