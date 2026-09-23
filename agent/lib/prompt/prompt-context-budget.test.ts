/** Deterministic authored-context budget guarding model prefill latency. */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { manageMemoryPresentation } from "../tools/manage_memory.js";
import { EXTERNAL_GROUP_TOOL_NAMES } from "../tool-policy/group-tool-catalog.js";
import { modeInstructions } from "./mode-instructions.js";

// The mode block is re-sent on every model step: rules that only matter when a specific tool is
// called belong in that tool's descriptor or skill, not here.
// Raised by 300 on 5 September 2026 for the owner's rule on mild, self-invented swearing.
// Raised by 400 on 9 September 2026: style records are a hint, not a promise; namesakes by username.
// Raised by 1200 on 24 September 2026 for the Telegram formatting guide. The inventory of allowed
// markup was there, but nothing said how to compose a readable answer — and nothing said that a
// lone newline is a space in Rich Markdown, which is what flattened the task board in production.
const CORE_CHARACTER_BUDGET = 12_900;
// Raised by 200 on 8 September 2026 for the mandatory used-memory directive wording, including
// the "after the answer, not instead of it" clause added after the directive-only eval case.
// Raised by 900 on 11 September 2026: раздел про дела, желания и традиции переехал сюда из
// описания `manage_shared_tasks`, иначе он уходил и во внешнюю группу по гранту. Для доверенного
// чата это перенос внутри того же кэшируемого префикса, а не новый текст.
// Raised by 300 on 14 September 2026 (upstream 4ca7a86): a chat setting is born only by an
// explicit durable request; a remark, joke or one-off "не делай так" is not stored.
// Raised by 300 on 21 September 2026: several tasks of one message go in one batch, and an
// unclear request to close tasks gets one question with short options instead of re-reading.
// Raised by 700 on 22 September 2026 for the coach reply section: consent only on an explicit
// yes, what to keep from an answer, and nothing shared with the partner unless asked.
// Raised by 500 on 22 September 2026 for the routing sentence: which words become a task, an idea,
// a tradition, a care area, a joint decision or personal time. Production had 35 tasks, 4 ideas
// and no traditions at all, because nothing told the model what to write with.
// Raised by 600 on 22 September 2026 for the section about what waits for the person's answer:
// which tool answers which kind, and that silence is never consent.
// Raised by 600 on 22 September 2026 for the weekly review reply section (T16, B08): which word of
// the person becomes which action, «хватит обзоров» turns it off, and «что давит» gets one warm
// sentence with no advice and no counting. The review itself is built by code.
// Raised by 400 on 23 September 2026 for the life-area sentence: which words become which label,
// that it is never added afterwards, and that a view of the same name filters by it.
const PRIVATE_CHARACTER_BUDGET = 16_700;
// Raised by 400 on 5 September 2026 for the memory selection criterion and slot guidance, then by
// 300 on 6 September for the addressing section with the explicit silence directive, then by
// 300 the same day for the pending-messages rule in that section, then by 200 on 7 September for
// the rule not to re-answer a question the agent already closed, then by 200 on 8 September for
// the group length ceiling, then by 100 for the mandatory used-memory directive wording.
// Raised by 400 on 9 September 2026 for the joke target rotation sentence.
// Raised by 900 on 11 September 2026 for the planning section moved out of the tool descriptor.
// Raised by 500 on 21 September 2026 for the listening family group: the triggeredBy field and
// the rule to record a task or stay silent when nobody addressed the agent (T03), then by 300
// the same day for the batch and one-question rule of the planning section.
// Raised by 500 on 22 September 2026 for the same routing sentence in the family block.
// Raised by 400 on 23 September 2026 for the same life-area sentence in the family block.
const FAMILY_CHARACTER_BUDGET = 17_800;
// Raised by 400 on 6 September 2026 for the addressing section with the explicit silence directive,
// then by 2 200 on 7 September for the participants section ported from upstream v0.21.2: opinions
// about behaviour on request, comparisons by a stated criterion, no diagnoses, no template refusal,
// then by 200 the same day for the rule not to re-answer a closed question, then by 200 on
// 8 September for the group length ceiling and by 100 for the mandatory used-memory directive.
const EXTERNAL_CHARACTER_BUDGET = 14_100;
// Raised by 400 on 5 September 2026 for the memory policy: the used-memory directive and the
// selection criterion with the discussion-summary slot, then by 400 on 6 September for the
// addressing section with the explicit silence directive, then by 2 200 on 7 September for the
// participants section ported from upstream v0.21.2, then by 200 for the closed-question rule,
// then by 200 on 8 September for the group length ceiling and by 100 for the mandatory directive.
// Raised by 200 on 14 September 2026 for the same chat-setting sentence (upstream 4ca7a86).
const EXTERNAL_WORST_CASE_CHARACTER_BUDGET = 23_700;
// Raised by 300 on 5 September 2026 for the two analyst skill lines in the external grant block,
// then by 600 the same day for the memory policy (used-memory directive, selection criterion),
// then by 300 for the owner's rule on mild, self-invented swearing in the core, then by 300 on
// 6 September for the addressing section with the explicit silence directive, then by 2 200 on
// 7 September for the participants section ported from upstream v0.21.2, then by 200 for the
// closed-question rule, then by 200 on 8 September for the group length ceiling and by 100 for
// the mandatory used-memory directive wording (200 in total: the worst case stacks two blocks).
// Raised by 300 on 14 September 2026 for the chat-setting sentence (upstream 4ca7a86).
// Raised by 1000 on 22 September 2026: the routing sentence lives in both trusted blocks.
// Raised by 1200 on 22 September 2026 for the partner-alert and weekly-review sections. The ceiling
// is actually held by the external worst case, which never gets either section, so the number moves
// for company: both live in the private block only.
// Raised by 800 on 23 September 2026: the life-area sentence lives in both trusted blocks.
const AUTHORED_TOTAL_CHARACTER_BUDGET = 38_300;

describe("authored prompt context budget", () => {
  it("keeps stable and mode-scoped instructions bounded", async () => {
    const core = await readFile("agent/instructions.md", "utf8");
    const privateMode = modeInstructions({ environment: "private" });
    const familyMode = modeInstructions({ environment: "family" });
    const externalMode = modeInstructions({
      capabilities: new Set(),
      environment: "external",
    });
    const allExternalCapabilities = new Set(EXTERNAL_GROUP_TOOL_NAMES);
    const externalWorstCases = [
      modeInstructions({
        capabilities: allExternalCapabilities,
        environment: "external",
        includeApplicationCore: true,
      }),
      modeInstructions({
        capabilities: allExternalCapabilities,
        environment: "external",
        includeApplicationCore: true,
        scheduledHistory: true,
      }),
      modeInstructions({
        capabilities: allExternalCapabilities,
        environment: "external",
        includeApplicationCore: true,
        scheduledHistory: true,
        scheduledRun: true,
      }),
    ];

    expect(core.length).toBeLessThanOrEqual(CORE_CHARACTER_BUDGET);
    expect(privateMode.length).toBeLessThanOrEqual(PRIVATE_CHARACTER_BUDGET);
    expect(familyMode.length).toBeLessThanOrEqual(FAMILY_CHARACTER_BUDGET);
    expect(externalMode.length).toBeLessThanOrEqual(EXTERNAL_CHARACTER_BUDGET);
    for (const mode of externalWorstCases) {
      expect(mode.length).toBeLessThanOrEqual(EXTERNAL_WORST_CASE_CHARACTER_BUDGET);
    }
    for (const mode of [privateMode, familyMode, externalMode, ...externalWorstCases]) {
      expect(core.length + mode.length).toBeLessThanOrEqual(AUTHORED_TOTAL_CHARACTER_BUDGET);
    }
  });

  it("does not ask ordinary memory edits to overwrite classification", () => {
    const { description } = manageMemoryPresentation(["edit"]);

    expect(description).toContain('"content":"Полная новая версия"');
    expect(description).not.toContain('"kind":"preference"');
    expect(description).not.toContain('"sensitivity":"normal"');
    expect(description).toContain("только при явном изменении классификации");
    // Mutation integrity guidance travels with the tool instead of every model step.
    expect(description).toContain("Сначала прочитай точную активную запись");
  });
});
