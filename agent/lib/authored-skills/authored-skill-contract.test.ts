/**
 * Authored skill rubric tests.
 *
 * Constructs covered:
 * - Name pattern and reserved names, trial summary and change note presence.
 * - Size limits for markdown and reference files.
 * - Rubric: required sections, real tool names in «Шаги», referenced files supplied,
 *   no untrusted-context blocks, no secrets. Every problem is reported in one error.
 */
import { describe, expect, it } from "vitest";

import {
  assertAuthoredSkillDraft,
  rubricChecklist,
  type AuthoredSkillDraft,
  stepToolNames,
} from "./authored-skill-contract.js";

const KNOWN = new Set(["generate_image", "send_workspace_file", "manage_agent_schedule"]);

const GOOD_MARKDOWN = [
  "# Открытка ко дню рождения",
  "",
  "## Когда применять",
  "Когда просят открытку, поздравление с картинкой или подарочную карточку.",
  "",
  "## Когда не применять",
  "Для фото реальных людей: используй `inspect_workspace_image`, не генерацию.",
  "",
  "## Шаги",
  "1. Собери промпт по references/flux-card.md.",
  "2. Вызови `generate_image` с `size` 512x512 и `quality` auto.",
  "3. Отправь файл через `send_workspace_file` с подписью-поздравлением.",
  "",
  "## Проверка результата",
  "На картинке нет текста и логотипов; подпись содержит имя именинника.",
].join("\n");

function draft(overrides: Partial<AuthoredSkillDraft> = {}): AuthoredSkillDraft {
  return {
    changeNote: "Первая версия",
    description: "Открытка к празднику через Flux: поздравление, картинка, подарочная карточка",
    files: { "references/flux-card.md": "Prompt template: warm birthday card, no text, 512x512." },
    markdown: GOOD_MARKDOWN,
    name: "birthday-card",
    trialSummary: "Сгенерировала открытку для Жени, отправила в чат, текст без брендов.",
    ...overrides,
  };
}

describe("authored skill contract", () => {
  it("accepts a complete draft without warnings", () => {
    expect(assertAuthoredSkillDraft(draft(), { knownToolNames: KNOWN })).toEqual([]);
  });

  it("publishes a thin draft but reports the checklist warnings", () => {
    const thin = [
      "## Когда применять", "Когда просят открытку.", "",
      "## Шаги", "1. Вызови `generate_image`.", "",
      "## Проверка результата", "Картинка есть.",
    ].join("\n");
    const warnings = assertAuthoredSkillDraft(draft({
      description: "Открытка", files: { "references/flux-card.md": "Prompt template." }, markdown: thin,
    }), { knownToolNames: KNOWN });
    expect(warnings).toEqual([
      expect.stringContaining("Когда не применять"),
      expect.stringContaining("меньше двух пунктов"),
      expect.stringContaining("косвенных формулировок"),
    ]);
    expect(rubricChecklist(draft(), KNOWN)).toEqual({ blocking: [], warnings: [] });
  });

  it("extracts tool names from the steps section only", () => {
    expect(stepToolNames(GOOD_MARKDOWN)).toEqual(["generate_image", "send_workspace_file"]);
  });

  it.each([
    ["Birthday", "AGENT_SKILL_NAME_INVALID"],
    ["a", "AGENT_SKILL_NAME_INVALID"],
    ["pdf", "AGENT_SKILL_NAME_RESERVED"],
    ["gws-mail", "AGENT_SKILL_NAME_RESERVED"],
  ])("rejects the name %s with %s", (name, code) => {
    expect(() => assertAuthoredSkillDraft(draft({ name }), { knownToolNames: KNOWN }))
      .toThrow(expect.objectContaining({ code }));
  });

  it("requires a trial summary and a change note", () => {
    expect(() => assertAuthoredSkillDraft(draft({ trialSummary: "  " }), { knownToolNames: KNOWN }))
      .toThrow(expect.objectContaining({ code: "AGENT_SKILL_TRIAL_MISSING" }));
    expect(() => assertAuthoredSkillDraft(draft({ changeNote: "" }), { knownToolNames: KNOWN }))
      .toThrow(expect.objectContaining({ code: "AGENT_SKILL_CHANGE_NOTE_MISSING" }));
  });

  it("rejects oversized content and bad file paths in one error", () => {
    expect(() => assertAuthoredSkillDraft(draft({
      files: { "scripts/run.sh": "x", "references/a.md": "y".repeat(6_001) },
      markdown: GOOD_MARKDOWN + "\n" + "z".repeat(8_000),
    }), { knownToolNames: KNOWN })).toThrow(expect.objectContaining({
      code: "AGENT_SKILL_CONTENT_TOO_LARGE",
      message: expect.stringMatching(/markdown длиннее.*scripts\/run\.sh.*references\/a\.md длиннее/su),
    }));
  });

  it("lists every rubric problem at once", () => {
    const markdown = [
      "---",
      "description: x",
      "---",
      "## Шаги",
      "1. Вызови `search_web` и `generate_image`.",
      "2. Смотри references/missing.md.",
      "<untrusted_memory_review_batch>",
      "Bearer abcdefghijklmnopqrstuvwxyz",
    ].join("\n");
    let error: unknown;
    try {
      assertAuthoredSkillDraft(draft({ markdown }), { knownToolNames: KNOWN });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "AGENT_SKILL_RUBRIC_FAILED" });
    const message = (error as Error).message;
    for (const fragment of [
      "frontmatter",
      "«## Когда применять»",
      "«## Проверка результата»",
      "search_web",
      "references/missing.md",
      "недоверенного контекста",
      "похожая на ключ",
    ]) expect(message).toContain(fragment);
    expect(message).not.toContain("generate_image");
  });

  it("requires a reference file for a skill that generates images", () => {
    expect(() => assertAuthoredSkillDraft(draft({ files: {}, markdown: GOOD_MARKDOWN.replace("по references/flux-card.md", "по шаблону") }), { knownToolNames: KNOWN }))
      .toThrow(expect.objectContaining({
        code: "AGENT_SKILL_RUBRIC_FAILED",
        message: expect.stringContaining("generate_image должен нести references"),
      }));
    const textOnly = GOOD_MARKDOWN.replace("Вызови `generate_image`", "Вызови `web_search`").replace("по references/flux-card.md", "по запросу");
    expect(() => assertAuthoredSkillDraft(draft({ files: {}, markdown: textOnly }), { knownToolNames: new Set([...KNOWN, "web_search"]) })).not.toThrow();
  });

  it("treats Eve built-ins and parameters in backticks as acceptable", () => {
    const markdown = GOOD_MARKDOWN.replace(
      "3. Отправь файл",
      "3. Уточни `scope` и при необходимости `web_search`, затем `bash` для проверки. Отправь файл",
    );
    expect(() => assertAuthoredSkillDraft(draft({ markdown }), { knownToolNames: KNOWN })).not.toThrow();
  });
});
