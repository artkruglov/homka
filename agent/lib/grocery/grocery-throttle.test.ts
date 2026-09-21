/**
 * Отказ по частоте у открытого источника это режим работы, а не авария: после него каталог
 * молчит до конца паузы, а повторная просьба человека не тратит ещё одну попытку.
 */
import { describe, expect, it, vi } from "vitest";

import { AppError } from "../app-error.js";
import { GROCERY_RATE_LIMIT_COOLDOWN_MS } from "./grocery-config.js";
import { createGroceryCatalog } from "./grocery-throttle.js";

function limited(): AppError {
  return new AppError("AGENT_GROCERY_RATE_LIMITED", "ВкусВилл временно ограничил число запросов");
}

function catalog(call: ReturnType<typeof vi.fn>, clock = { value: 0 }) {
  const sleep = vi.fn().mockResolvedValue(undefined);
  return {
    call,
    clock,
    sleep,
    run: createGroceryCatalog({
      call: call as unknown as (name: string, args: Record<string, unknown>) => Promise<unknown>,
      now: () => clock.value,
      sleep,
    }),
  };
}

const search = { q: "творог" };

describe("grocery catalog throttle", () => {
  it("retries a rate-limited read once after a pause", async () => {
    const call = vi.fn().mockRejectedValueOnce(limited()).mockResolvedValue({ ok: true });
    const { run, sleep } = catalog(call);

    await expect(run("vkusvill_products_search", search)).resolves.toEqual({ ok: true });
    expect(call).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("stops asking the source until the cooldown ends and names the wait", async () => {
    const call = vi.fn().mockRejectedValue(limited());
    const clock = { value: 1_000 };
    const { run } = catalog(call, clock);

    await expect(run("vkusvill_products_search", search)).rejects.toMatchObject({
      code: "AGENT_GROCERY_RATE_LIMITED",
      message: expect.stringContaining("10 мин"),
    });
    expect(call).toHaveBeenCalledTimes(2);

    clock.value += 60_000;
    await expect(run("vkusvill_products_search", { q: "молоко" })).rejects.toMatchObject({
      message: expect.stringContaining("9 мин"),
    });
    expect(call).toHaveBeenCalledTimes(2);

    clock.value += GROCERY_RATE_LIMIT_COOLDOWN_MS;
    call.mockResolvedValue({ ok: true });
    await expect(run("vkusvill_products_search", { q: "молоко" })).resolves.toEqual({ ok: true });
  });

  it("serves a repeated read from cache and lets it expire", async () => {
    const call = vi.fn().mockResolvedValue({ ok: true });
    const clock = { value: 0 };
    const { run } = catalog(call, clock);

    await run("vkusvill_product_details", { id: 7 });
    await run("vkusvill_product_details", { id: 7 });
    expect(call).toHaveBeenCalledOnce();

    await run("vkusvill_product_details", { id: 8 });
    expect(call).toHaveBeenCalledTimes(2);

    clock.value += 11 * 60_000;
    await run("vkusvill_product_details", { id: 7 });
    expect(call).toHaveBeenCalledTimes(3);
  });

  it("never repeats or caches cart link creation", async () => {
    const call = vi.fn().mockResolvedValue({ ok: true });
    const { run } = catalog(call);

    await run("vkusvill_cart_link_create", { products: [] });
    await run("vkusvill_cart_link_create", { products: [] });
    expect(call).toHaveBeenCalledTimes(2);

    call.mockRejectedValue(limited());
    await expect(run("vkusvill_cart_link_create", { products: [] })).rejects.toMatchObject({
      code: "AGENT_GROCERY_RATE_LIMITED",
    });
    expect(call).toHaveBeenCalledTimes(3);
  });

  it("passes a plain failure through without starting a cooldown", async () => {
    const call = vi.fn()
      .mockRejectedValueOnce(new AppError("AGENT_GROCERY_UNAVAILABLE", "нет связи"))
      .mockResolvedValue({ ok: true });
    const { run } = catalog(call);

    await expect(run("vkusvill_products_search", search)).rejects.toMatchObject({
      code: "AGENT_GROCERY_UNAVAILABLE",
    });
    await expect(run("vkusvill_products_search", search)).resolves.toEqual({ ok: true });
  });
});
