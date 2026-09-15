/**
 * Owner-only library of Mia's authored skills.
 *
 * Export:
 * - `manage_skill`: list / read the family library, publish, roll back or retire a skill through
 *   Telegram HITL, grant or revoke it for an external group, and record how the last application
 *   of a skill went.
 *
 * Key constructs:
 * - A skill adds procedure, never rights: the rubric refuses tool names outside the current mode.
 * - Mutations run only after the exact Eve tool call was approved by the owner and the owner role
 *   was re-read from the database; the same call replayed after approval creates nothing twice.
 * - Published content is visible from the next turn: the dynamic resolver reads the library on
 *   `turn.started`, so the result says so instead of promising immediate availability.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { AppError } from "../app-error.js";
import {
  AUTHORED_SKILL_LIMITS,
  AUTHORED_SKILL_REQUIRED_SECTIONS,
  EVE_BUILTIN_TOOL_NAMES,
} from "../authored-skills/authored-skill-contract.js";
import {
  AUTHORED_SKILL_EXAMPLE_MAX_CHARACTERS,
  AUTHORED_SKILL_EXAMPLES_MAX,
  authoredSkillExampleRepository,
} from "../authored-skills/authored-skill-example-repository.js";
import { authoredSkillGrantRepository } from "../authored-skills/authored-skill-grant-repository.js";
import { authoredSkillRepository } from "../authored-skills/authored-skill-repository.js";
import { requireTrustedTelegramOwner, type TrustedTelegramOwner } from "../family-context.js";
import { requireToolApprovalEvidence } from "../require-tool-approval-evidence.js";

const TOOL_DESCRIPTION = [
  "Библиотека собственных навыков, одна на семью: list, read, publish, rollback, retire, record_outcome, grant, revoke, add_example, remove_example. Только владелец, только в личном чате владельца или семейной группе.",
  "Когда применять: владелец просит создать, улучшить, откатить или убрать навык; ты предлагаешь сохранить повторяемую задачу как навык по служебной подсказке; после применения навыка владелец сказал, что вышло хорошо или плохо. Сначала загрузи skill-authoring через load_skill: он задаёт порядок работы и рубрику.",
  "Когда не применять: стиль общения это manage_behavior_preference; факт о человеке это remember; разовая задача просто выполняется без навыка; расписание это manage_agent_schedule.",
  "Publish требует пробного прогона в этом ходу: запрос в trialRequest, результат в trialSummary; пара сохраняется как пример навыка (до 5, read показывает их с id). Версия 2+: прогони каждый пример заново и передай trials по всем, иначе AGENT_SKILL_EVAL_MISSING. Publish, rollback, retire, grant и revoke требуют кнопки владельца. Опубликованный навык доступен со следующего хода.",
  `Markdown навыка без frontmatter, обязательные разделы: ${AUTHORED_SKILL_REQUIRED_SECTIONS.map((section) => `«${section}»`).join(", ")}; в шагах имена инструментов в обратных кавычках только из текущего режима; навык с generate_image обязан нести references/<имя>.md с английским шаблоном промпта. Лимиты: markdown ${AUTHORED_SKILL_LIMITS.markdownMaxCharacters} символов, до ${AUTHORED_SKILL_LIMITS.filesMax} файлов references/<имя>.md по ${AUTHORED_SKILL_LIMITS.fileMaxCharacters} символов, ${AUTHORED_SKILL_LIMITS.activeSkillsPerFamily} активных навыков на семью.`,
  "Publish: {\"action\":\"publish\",\"name\":\"birthday-card\",\"description\":\"Открытка к празднику через Flux: поздравление с картинкой, подарочная карточка\",\"markdown\":\"## Когда применять\\n…\\n## Шаги\\n1. Вызови `generate_image`…\\n## Проверка результата\\n…\",\"files\":{\"references/flux-card.md\":\"…\"},\"changeNote\":\"Первая версия\",\"trialRequest\":\"Открытка Жене на день рождения\",\"trialSummary\":\"Сделала открытку, отправила в чат\"}; версия 2 плюс \"trials\":[{\"exampleId\":\"…\",\"summary\":\"…\"}]. Add_example: name, request, expected. Remove_example: name, exampleId.",
  "Rollback: {\"action\":\"rollback\",\"name\":\"birthday-card\",\"version\":1}. Retire и read: name (read принимает version). Record_outcome: {\"action\":\"record_outcome\",\"name\":\"birthday-card\",\"outcome\":\"failed\",\"note\":\"на картинке появился текст\"}.",
  `Grant выдаёт навык внешней группе (group: название или chat id), revoke забирает; до ${AUTHORED_SKILL_LIMITS.grantsPerGroup} навыков на группу. Навык прав не добавляет: инструмент из шагов, не выданный группе, приводит к отказу с перечнем недостающих. List показывает гранты.`,
].join(" ");

const MUTATING_ACTIONS = new Set(["grant", "publish", "retire", "revoke", "rollback"]);

const manageSkillSchema = z.object({
  action: z.enum(["add_example", "grant", "list", "publish", "read", "record_outcome", "remove_example", "retire", "revoke", "rollback"]),
  changeNote: z.string().max(AUTHORED_SKILL_LIMITS.changeNoteMaxCharacters).optional()
    .describe("publish: что изменилось и зачем"),
  description: z.string().max(AUTHORED_SKILL_LIMITS.descriptionMaxCharacters).optional()
    .describe("publish: триггер загрузки, задача плюс косвенные формулировки"),
  exampleId: z.uuid().optional().describe("remove_example: id примера из read"),
  expected: z.string().max(AUTHORED_SKILL_EXAMPLE_MAX_CHARACTERS).optional()
    .describe("add_example: каким должен быть правильный результат"),
  files: z.record(z.string(), z.string()).optional()
    .describe("publish: справочные файлы references/<имя>.md"),
  group: z.string().max(200).optional()
    .describe("grant, revoke: название внешней группы или её отрицательный chat id"),
  markdown: z.string().max(AUTHORED_SKILL_LIMITS.markdownMaxCharacters).optional()
    .describe("publish: тело SKILL.md без frontmatter"),
  name: z.string().max(40).optional().describe("Имя навыка: строчные латинские буквы, цифры, дефис"),
  note: z.string().max(500).optional().describe("record_outcome: что именно вышло не так или хорошо"),
  outcome: z.enum(["failed", "ok"]).optional().describe("record_outcome: исход последнего применения"),
  request: z.string().max(AUTHORED_SKILL_EXAMPLE_MAX_CHARACTERS).optional()
    .describe("add_example: запрос человека, на котором навык проверяется"),
  trialRequest: z.string().max(AUTHORED_SKILL_EXAMPLE_MAX_CHARACTERS).optional()
    .describe("publish: запрос, на котором выполнен пробный прогон; сохраняется как пример"),
  trials: z.array(z.object({
    exampleId: z.uuid(),
    summary: z.string().min(1).max(AUTHORED_SKILL_EXAMPLE_MAX_CHARACTERS),
  }).strict()).max(AUTHORED_SKILL_EXAMPLES_MAX).optional()
    .describe("publish версии 2+: прогон каждого сохранённого примера и что получилось"),
  trialSummary: z.string().max(AUTHORED_SKILL_LIMITS.trialSummaryMaxCharacters).optional()
    .describe("publish: что выполнено в пробном прогоне и что получилось"),
  version: z.number().int().min(1).optional().describe("read: версия; rollback: к какой версии вернуться"),
}).strict();

type ManageSkillInput = z.infer<typeof manageSkillSchema>;

function requireName(input: ManageSkillInput): string {
  if (typeof input.name !== "string" || input.name.length === 0) {
    throw new AppError("AGENT_SKILL_INPUT_INVALID", "Укажи name навыка");
  }
  return input.name;
}

function requireGroup(input: ManageSkillInput): string {
  if (typeof input.group !== "string" || input.group.trim().length === 0) {
    throw new AppError("AGENT_SKILL_INPUT_INVALID", "Укажи group: название внешней группы или её chat id");
  }
  return input.group;
}

function requireField(
  input: ManageSkillInput,
  key: "changeNote" | "description" | "expected" | "markdown" | "request" | "trialRequest" | "trialSummary",
  action = "publish",
): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError("AGENT_SKILL_INPUT_INVALID", `Для ${action} обязательно поле ${key}`);
  }
  return value;
}

/** Tool names the rubric accepts: the trusted catalog of this mode plus Eve built-ins. */
async function knownToolNames(owner: TrustedTelegramOwner): Promise<Set<string>> {
  // Lazy import: the catalog imports this tool, so a static import would be a cycle.
  const catalog = await import("../tool-policy/trusted-mode-tool-catalog.js");
  const modeOnly = owner.chatKind === "private" ? catalog.PRIVATE_ONLY_TOOL_NAMES : catalog.FAMILY_ONLY_TOOL_NAMES;
  return new Set([...catalog.TRUSTED_MODE_TOOL_NAMES, ...modeOnly, ...EVE_BUILTIN_TOOL_NAMES]);
}

export default defineTool({
  approval: ({ toolInput }) => {
    const action = (toolInput as { action?: unknown } | null)?.action;
    return typeof action === "string" && MUTATING_ACTIONS.has(action) ? "user-approval" : "not-applicable";
  },
  description: TOOL_DESCRIPTION,
  inputSchema: manageSkillSchema,
  async execute(input, ctx) {
    const owner = requireTrustedTelegramOwner(ctx);
    const caller = { familyId: owner.familyId, role: owner.role, userId: owner.userId };
    const provenance = { eveSessionId: ctx.session.id, eveTurnId: ctx.session.turn.id };
    const nextTurnNote = "Навык доступен со следующего хода";

    switch (input.action) {
      case "list":
        return {
          grants: await authoredSkillGrantRepository.grants(owner.familyId),
          skills: await authoredSkillRepository.list(owner.familyId),
        };
      case "grant": {
        await requireToolApprovalEvidence(ctx, "manage_skill", input);
        const result = await authoredSkillGrantRepository.grant(caller, { group: requireGroup(input), name: requireName(input) });
        return { ...result, note: result.granted ? "Навык доступен группе со следующего хода" : "Навык уже был выдан этой группе" };
      }
      case "revoke": {
        await requireToolApprovalEvidence(ctx, "manage_skill", input);
        const result = await authoredSkillGrantRepository.revoke(caller, { group: requireGroup(input), name: requireName(input) });
        return { ...result, note: "Группа больше не получает этот навык" };
      }
      case "read":
        return await authoredSkillRepository.read(owner.familyId, requireName(input), input.version);
      case "record_outcome": {
        if (input.outcome === undefined) {
          throw new AppError("AGENT_SKILL_INPUT_INVALID", "Для record_outcome укажи outcome: ok или failed");
        }
        const conversationId = await authoredSkillRepository.conversationId(owner);
        return await authoredSkillRepository.recordOutcome(caller, {
          conversationId, name: requireName(input), note: input.note ?? null, outcome: input.outcome, source: "owner",
        });
      }
      case "publish": {
        const draft = {
          changeNote: requireField(input, "changeNote"),
          description: requireField(input, "description"),
          files: input.files ?? {},
          markdown: requireField(input, "markdown"),
          name: requireName(input),
          trialSummary: requireField(input, "trialSummary"),
        };
        const trialRequest = requireField(input, "trialRequest");
        // Owner role and the exact Telegram approval are both revalidated at the mutation boundary.
        await requireToolApprovalEvidence(ctx, "manage_skill", input);
        const result = await authoredSkillRepository.publish(caller, draft, {
          knownToolNames: await knownToolNames(owner), operationKey: ctx.callId, provenance,
          trialRequest, trials: input.trials ?? [],
        });
        return { ...result, note: nextTurnNote };
      }
      case "add_example":
        return await authoredSkillExampleRepository.add(caller, {
          expected: requireField(input, "expected", "add_example"), name: requireName(input),
          request: requireField(input, "request", "add_example"),
        });
      case "remove_example": {
        if (input.exampleId === undefined) {
          throw new AppError("AGENT_SKILL_INPUT_INVALID", "Для remove_example укажи exampleId из read");
        }
        return await authoredSkillExampleRepository.remove(caller, { exampleId: input.exampleId, name: requireName(input) });
      }
      case "rollback": {
        if (input.version === undefined) {
          throw new AppError("AGENT_SKILL_INPUT_INVALID", "Для rollback укажи version, к которой вернуться");
        }
        await requireToolApprovalEvidence(ctx, "manage_skill", input);
        const result = await authoredSkillRepository.rollback(caller, {
          knownToolNames: await knownToolNames(owner), name: requireName(input),
          operationKey: ctx.callId, provenance, version: input.version,
        });
        return { ...result, note: nextTurnNote };
      }
      case "retire": {
        await requireToolApprovalEvidence(ctx, "manage_skill", input);
        const result = await authoredSkillRepository.retire(caller, { name: requireName(input) });
        return { ...result, note: "Навык убран из выдачи; история версий сохранена" };
      }
    }
  },
});
