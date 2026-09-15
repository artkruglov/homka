/**
 * Карточка обязана перечислять то, что чат действительно умеет. Поэтому она строится из
 * настоящего набора инструментов, а каждый инструмент доверенного набора обязан иметь семью:
 * иначе новая возможность появится в чате, а в ответе на «что ты умеешь» её не будет.
 */
import { describe, expect, it } from "vitest";

import { CAPABILITY_GROUPS, chatCapabilities } from "./chat-capabilities.js";
import {
  FAMILY_ONLY_TOOL_NAMES,
  PRIVATE_ONLY_TOOL_NAMES,
  TRUSTED_MODE_TOOL_NAMES,
} from "../tool-policy/trusted-mode-tool-catalog.js";

describe("chat capability card", () => {
  it("gives every trusted tool exactly one family", () => {
    const owners = new Map<string, string[]>();
    for (const [group, { tools }] of Object.entries(CAPABILITY_GROUPS)) {
      for (const tool of tools) owners.set(tool, [...(owners.get(tool) ?? []), group]);
    }
    const trusted = [
      ...TRUSTED_MODE_TOOL_NAMES, ...PRIVATE_ONLY_TOOL_NAMES, ...FAMILY_ONLY_TOOL_NAMES,
    ];

    expect(trusted.filter((tool) => (owners.get(tool) ?? []).length !== 1)).toEqual([]);
  });

  it("names only the families the current chat actually has", () => {
    expect(chatCapabilities(["manage_shopping_list", "grocery_cart"])).toEqual([
      { group: "groceries", label: "Продукты и корзина" },
      { group: "planning", label: "Дела, идеи и традиции" },
    ]);
    expect(chatCapabilities([])).toEqual([]);
  });
});
