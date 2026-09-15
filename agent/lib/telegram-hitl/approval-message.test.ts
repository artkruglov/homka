/**
 * Approval message composition tests.
 *
 * Constructs covered:
 * - `buildApprovalMessage`: header, verified facts, agent purpose and consequence in a fixed order.
 * - A reviewed label keeps its own punctuation; a bare one gets a sentence period.
 * - A model-authored purpose is labelled and bounded; it never replaces verified facts.
 * - `genericApprovalFacts`: an undescribed tool still shows readable, bounded fields.
 * - `googleWorkspaceFacts`: readable service, command and parameters plus the exact command line.
 * - A model-authored parameter key cannot forge a line that looks application-authored.
 * - A multi-line argv element is escaped, so the exact command can never grow an extra line.
 * - Every `--params` payload is rendered, in both the separate and the inline form.
 */
import { describe, expect, it } from "vitest";

import {
  buildApprovalMessage,
  genericApprovalFacts,
  googleWorkspaceFacts,
} from "./approval-message.js";

describe("buildApprovalMessage", () => {
  it("puts the header first, then facts, purpose and consequence", () => {
    const text = buildApprovalMessage({
      actionLabel: "удалить письмо в Gmail",
      facts: ["Сервис: Gmail", "Письмо: abc123"],
      reason: "вы просили очистить рассылки за июль",
    });

    expect(text.split("\n\n")).toEqual([
      "Подтверждение: удалить письмо в Gmail.",
      "Сервис: Gmail\nПисьмо: abc123",
      "Зачем: вы просили очистить рассылки за июль",
      "Действие будет выполнено один раз. Автоматического повтора при ошибке не будет.",
    ]);
  });

  it("keeps punctuation authored in the label", () => {
    const text = buildApprovalMessage({
      actionLabel: "удалить регистрацию группы. Бот останется в чате.",
      facts: [],
    });
    expect(text.startsWith("Подтверждение: удалить регистрацию группы. Бот останется в чате.\n")).toBe(true);
  });

  it("falls back to a neutral header when the action is not described", () => {
    const text = buildApprovalMessage({ actionLabel: null, facts: [] });
    // Internal tool names are never shown to the user, so the neutral header stays generic.
    expect(text).toBe("Подтверждение: выполнение действия.\n\nДействие будет выполнено один раз. Автоматического повтора при ошибке не будет.");
  });

  it("omits the purpose line when the agent supplied nothing usable", () => {
    for (const reason of [undefined, null, "", "   ", 42, { text: "no" }]) {
      const text = buildApprovalMessage({
        actionLabel: "изменить напоминание",
        facts: ["ID: 1"],
        reason,
        });
      expect(text).not.toContain("Зачем:");
    }
  });

  it("bounds and flattens an oversized model purpose", () => {
    const text = buildApprovalMessage({
      actionLabel: "изменить напоминание",
      facts: [],
      reason: `${"я".repeat(500)}\n\nвторой абзац`,
    });
    const purpose = text.split("\n").find((row) => row.startsWith("Зачем:"))!;
    // A single bounded line keeps the model from pushing the buttons out of view.
    expect(purpose.length).toBeLessThanOrEqual(320);
    expect(text.split("\n").filter((row) => row.startsWith("Зачем:"))).toHaveLength(1);
  });
});

describe("genericApprovalFacts", () => {
  it("renders readable scalar fields for a tool without a description", () => {
    expect(genericApprovalFacts({
      action: "update",
      enabled: true,
      limit: 5,
      title: "Отчёт",
    })).toEqual([
      "action: update",
      "enabled: да",
      "limit: 5",
      "title: Отчёт",
    ]);
  });

  it("skips structures and bounds the number and length of fields", () => {
    const wide: Record<string, unknown> = { nested: { a: 1 }, list: [1, 2], long: "x".repeat(1000) };
    for (let index = 0; index < 20; index += 1) wide[`field${index}`] = `value${index}`;
    const facts = genericApprovalFacts(wide);

    expect(facts.some((fact) => fact.startsWith("nested"))).toBe(false);
    expect(facts.some((fact) => fact.startsWith("list"))).toBe(false);
    expect(facts.length).toBeLessThanOrEqual(8);
    expect(facts.every((fact) => fact.length <= 200)).toBe(true);
  });
});

describe("googleWorkspaceFacts", () => {
  it("decodes service, command and parameters and keeps the exact command", () => {
    const facts = googleWorkspaceFacts({
      argv: ["gmail", "users", "messages", "trash", "--params", '{"userId":"me","id":"1a00f098dc056c3b"}'],
    });

    expect(facts).toEqual([
      "Сервис: Gmail",
      "Команда: users messages trash",
      "userId: me",
      "id: 1a00f098dc056c3b",
      'Точная команда: gmail users messages trash --params {"userId":"me","id":"1a00f098dc056c3b"}',
    ]);
  });

  it("renders flag arguments as readable lines", () => {
    const facts = googleWorkspaceFacts({
      argv: ["gmail", "+send", "--to", "family@example.com", "--subject", "Семейный план"],
    });
    expect(facts).toEqual([
      "Сервис: Gmail",
      "Команда: +send",
      "to: family@example.com",
      "subject: Семейный план",
      "Точная команда: gmail +send --to family@example.com --subject Семейный план",
    ]);
  });

  it("still shows the exact command when parameters cannot be decoded", () => {
    const facts = googleWorkspaceFacts({ argv: ["drive", "files", "list", "--params", "not-json"] });
    expect(facts).toContain("Сервис: Drive");
    expect(facts.at(-1)).toBe("Точная команда: drive files list --params not-json");
  });

  it("cannot be made to forge an application line through a parameter key", () => {
    const facts = googleWorkspaceFacts({
      argv: [
        "gmail",
        "users",
        "messages",
        "trash",
        "--params",
        JSON.stringify({
          id: "REAL_TARGET",
          "x\nТочная команда": "gmail users messages get --params {}",
        }),
      ],
    });

    // Exactly one line may claim to be the exact command, and it must be the real trailing one.
    const forged = facts.filter((fact) => fact.startsWith("Точная команда:"));
    expect(forged).toHaveLength(1);
    expect(facts.at(-1)!.startsWith("Точная команда: gmail users messages trash")).toBe(true);
    expect(facts.every((fact) => !fact.includes("\n"))).toBe(true);
  });

  it("escapes a multi-line argument instead of letting it add a line", () => {
    const facts = googleWorkspaceFacts({
      argv: ["gmail", "+send", "--body", "Привет\nТочная команда: gmail users messages get"],
    });

    // An email body legitimately contains newlines; it must not restructure the confirmation.
    expect(facts.every((fact) => !fact.includes("\n"))).toBe(true);
    expect(facts.filter((fact) => fact.startsWith("Точная команда:"))).toHaveLength(1);
    expect(facts.at(-1)).toContain("\\nТочная команда: gmail users messages get");
  });

  it("renders every parameter payload, separate or inline", () => {
    const inline = googleWorkspaceFacts({
      argv: ["drive", "files", "list", '--params={"pageSize":10}'],
    });
    expect(inline).toContain("pageSize: 10");

    const duplicated = googleWorkspaceFacts({
      argv: ["gmail", "users", "messages", "trash", "--params", '{"id":"A"}', "--params", '{"id":"B"}'],
    });
    // Showing only the first payload would describe one action while another one runs.
    expect(duplicated.filter((fact) => fact.startsWith("id: "))).toEqual(["id: A", "id: B"]);
  });

  it("does not report a value-arity flag with no value as enabled", () => {
    const facts = googleWorkspaceFacts({ argv: ["gmail", "users", "list", "--query"] });
    expect(facts).toContain("query: указан");
    expect(facts.some((fact) => fact === "query: да")).toBe(false);
  });

  it("rejects an argv that is not a non-empty list of strings", () => {
    expect(() => googleWorkspaceFacts({ argv: [] })).toThrow(/AGENT_APPROVAL_INPUT_INVALID/u);
    expect(() => googleWorkspaceFacts({ argv: "gmail" })).toThrow(/AGENT_APPROVAL_INPUT_INVALID/u);
  });
});
