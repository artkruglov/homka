/**
 * Regression tests for the model-facing `remember` input contract.
 *
 * Covers:
 * - strict normalization of a JSON-serialized `subject` emitted by a model provider;
 * - normalization through the same AI SDK schema adapter used for tool calls;
 * - rejection of malformed or structurally invalid serialized subjects.
 */
import { zodSchema } from "ai";
import { describe, expect, it } from "vitest";

import { externalRememberInputSchema } from "./remember-contract.js";

const BASE_EXTERNAL_INPUT = {
  basis: "agent_inferred",
  content: "Пользователь завершил обсуждавшийся эпизод.",
  kind: "episode",
  scope: "group",
  sensitivity: "normal",
} as const;

describe("externalRememberInputSchema", () => {
  it("accepts the exact production payload through the AI SDK validator", async () => {
    const schema = zodSchema(externalRememberInputSchema);
    const result = await schema.validate!({
      ...BASE_EXTERNAL_INPUT,
      subject: '{"kind":"current_author"}',
    });

    expect(result).toMatchObject({
      success: true,
      value: { subject: { kind: "current_author" } },
    });
  });

  it.each([
    ['{"kind":"current_author"}', { kind: "current_author" }],
    [' { "kind" : "none" } ', { kind: "none" }],
    [
      '{"kind":"verified_ref","subjectRef":"subj_0123456789abcdef0123456789abcdef"}',
      { kind: "verified_ref", subjectRef: "subj_0123456789abcdef0123456789abcdef" },
    ],
    ['{"label":"Проект \\"Осинара\\"","kind":"label"}', { kind: "label", label: 'Проект "Осинара"' }],
  ])("normalizes a provider-serialized subject: %s", (subject, expected) => {
    const result = externalRememberInputSchema.safeParse({
      ...BASE_EXTERNAL_INPUT,
      subject,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subject).toEqual(expected);
    }
  });

  it.each([
    ["malformed JSON", '{"kind":'],
    ["invalid subject shape", '{"kind":"current_author","subjectRef":"subj_0123456789abcdef0123456789abcdef"}'],
  ])("rejects %s instead of weakening subject validation", (_caseName, subject) => {
    expect(externalRememberInputSchema.safeParse({
      ...BASE_EXTERNAL_INPUT,
      subject,
    }).success).toBe(false);
  });

  it("accepts an attribute slot for profile claims and rejects it for episodes", () => {
    const base = {
      basis: "agent_inferred",
      content: "Работает логистом",
      scope: "group",
      sensitivity: "normal",
      subject: { kind: "current_author" },
    };
    expect(externalRememberInputSchema.safeParse({ ...base, attribute: "работа", kind: "profile" }).success).toBe(true);
    expect(externalRememberInputSchema.safeParse({ ...base, attribute: "работа", kind: "episode" }).success).toBe(false);
    expect(externalRememberInputSchema.safeParse({
      ...base, attribute: "итог обсуждения", kind: "episode", subject: { kind: "label", label: "архитектура агента" },
    }).success).toBe(true);
    expect(externalRememberInputSchema.safeParse({ ...base, attribute: "x".repeat(65), kind: "profile" }).success).toBe(false);
  });

  it("accepts occurredAt only for episodes and only as an ISO date", () => {
    const base = {
      basis: "agent_inferred",
      content: "Serje едет в Питер",
      scope: "group",
      sensitivity: "normal",
      subject: { kind: "current_author" },
    };
    expect(externalRememberInputSchema.safeParse({ ...base, kind: "episode", occurredAt: "2026-09-08" }).success).toBe(true);
    expect(externalRememberInputSchema.safeParse({ ...base, kind: "episode", occurredAt: "2026-09-08T10:00:00Z" }).success).toBe(true);
    expect(externalRememberInputSchema.safeParse({ ...base, kind: "fact", occurredAt: "2026-09-08" }).success).toBe(false);
    expect(externalRememberInputSchema.safeParse({ ...base, kind: "episode", occurredAt: "8 сентября" }).success).toBe(false);
  });
});
