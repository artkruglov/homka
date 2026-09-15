/**
 * Authored skill contract: limits, reserved names and the deterministic publication rubric.
 *
 * Exports:
 * - `AUTHORED_SKILL_LIMITS`, `AUTHORED_SKILL_REQUIRED_SECTIONS`, `EVE_BUILTIN_TOOL_NAMES`.
 * - `AuthoredSkillDraft`: the exact payload a publish carries.
 * - `assertAuthoredSkillDraft`: throws a coded AppError listing every rubric problem at once.
 * - `isReservedSkillName`, `stepToolNames`: helpers shared with tests and the tool description.
 * - `externalGroupMissingTools`: step tools an external group's allowlist does not cover.
 *
 * Key constructs:
 * - The rubric checks structure only: sections exist, tool names in the steps are real, referenced
 *   files were supplied, no untrusted-context blocks and no secrets were pasted in. Whether the
 *   steps reach the goal is the owner's call after the trial run, never the backend's.
 * - A snake_case token in backticks inside «Шаги» is treated as a tool name; single words such as
 *   `action` or `scope` are parameters and stay unchecked.
 */
import { AppError } from "../app-error.js";
import { ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES } from "../tool-policy/group-tool-catalog.js";

export const AUTHORED_SKILL_LIMITS = Object.freeze({
  activeSkillsPerFamily: 40,
  changeNoteMaxCharacters: 500,
  descriptionMaxCharacters: 400,
  fileMaxCharacters: 6_000,
  filesMax: 4,
  /** Every granted skill costs one line of the external prompt and one package per turn. */
  grantsPerGroup: 10,
  markdownMaxCharacters: 8_000,
  trialSummaryMaxCharacters: 1_000,
});

export const AUTHORED_SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/u;
export const AUTHORED_SKILL_FILE_PATTERN = /^references\/[a-z0-9][a-z0-9-]{0,39}\.md$/u;

export const AUTHORED_SKILL_REQUIRED_SECTIONS = Object.freeze([
  "## Когда применять",
  "## Шаги",
  "## Проверка результата",
]);

/** Framework tools a skill may name besides the application catalog of its mode. */
export const EVE_BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "agent", "ask_question", "bash", "glob", "grep", "load_skill", "read_file", "todo",
  "web_fetch", "web_search", "write_file",
]);

const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "agent-browser", "authored", "behavior-preferences", "docx", "imagegen", "pdf",
  "skill-authoring", "xlsx",
]);
const RESERVED_PREFIXES = ["authored-", "gws-"] as const;

const UNTRUSTED_BLOCK_PATTERN =
  /<\/?(?:untrusted[a-z_]*|retrieved_long_term_memory|existing_memory|preceding_context|memory_review_source_selection)\b/iu;
const SECRET_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{8,}|cfat_[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{16,})/u;
const REFERENCE_MENTION_PATTERN = /references\/[a-z0-9][a-z0-9-]{0,39}\.md/gu;
const STEP_TOOL_PATTERN = /`([a-z]+(?:_[a-z0-9]+)+|agent|bash|glob|grep|todo)`/gu;

export interface AuthoredSkillDraft {
  readonly changeNote: string;
  readonly description: string;
  readonly files: Readonly<Record<string, string>>;
  readonly markdown: string;
  readonly name: string;
  readonly trialSummary: string;
}

export function isReservedSkillName(name: string): boolean {
  return RESERVED_NAMES.has(name) || RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function sectionBody(markdown: string, heading: string): string | null {
  const start = markdown.indexOf(`\n${heading}`);
  const from = start === -1 ? (markdown.startsWith(heading) ? 0 : -1) : start + 1;
  if (from === -1) return null;
  const rest = markdown.slice(from + heading.length);
  const next = rest.search(/\n## /u);
  return next === -1 ? rest : rest.slice(0, next);
}

/** Step tools an external group cannot call: everything outside its allowlist and the baseline file tools. */
export function externalGroupMissingTools(
  markdown: string,
  allowed: ReadonlySet<string>,
): string[] {
  return stepToolNames(markdown).filter((name) =>
    !allowed.has(name) && !(ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES as readonly string[]).includes(name)
  );
}

/** Tool names the «Шаги» section refers to, in order of first mention. */
export function stepToolNames(markdown: string): string[] {
  const steps = sectionBody(markdown, "## Шаги");
  if (steps === null) return [];
  const names: string[] = [];
  for (const match of steps.matchAll(STEP_TOOL_PATTERN)) {
    const name = match[1]!;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

function sizeProblems(draft: AuthoredSkillDraft): string[] {
  const limits = AUTHORED_SKILL_LIMITS;
  const problems: string[] = [];
  if (draft.description.trim().length === 0) problems.push("description пустое");
  if (draft.description.length > limits.descriptionMaxCharacters) {
    problems.push(`description длиннее ${limits.descriptionMaxCharacters} символов`);
  }
  if (draft.markdown.trim().length === 0) problems.push("markdown пустой");
  if (draft.markdown.length > limits.markdownMaxCharacters) {
    problems.push(`markdown длиннее ${limits.markdownMaxCharacters} символов`);
  }
  const fileEntries = Object.entries(draft.files);
  if (fileEntries.length > limits.filesMax) problems.push(`файлов больше ${limits.filesMax}`);
  for (const [path, content] of fileEntries) {
    if (!AUTHORED_SKILL_FILE_PATTERN.test(path)) {
      problems.push(`путь файла ${path} не вида references/<имя>.md`);
    }
    if (content.trim().length === 0) problems.push(`файл ${path} пустой`);
    if (content.length > limits.fileMaxCharacters) {
      problems.push(`файл ${path} длиннее ${limits.fileMaxCharacters} символов`);
    }
  }
  if (draft.changeNote.length > limits.changeNoteMaxCharacters) {
    problems.push(`changeNote длиннее ${limits.changeNoteMaxCharacters} символов`);
  }
  if (draft.trialSummary.length > limits.trialSummaryMaxCharacters) {
    problems.push(`trialSummary длиннее ${limits.trialSummaryMaxCharacters} символов`);
  }
  return problems;
}

function rubricProblems(draft: AuthoredSkillDraft, knownToolNames: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  if (/^---\s*\n/u.test(draft.markdown)) {
    problems.push("markdown начинается с frontmatter; description передаётся отдельным полем");
  }
  for (const heading of AUTHORED_SKILL_REQUIRED_SECTIONS) {
    if (sectionBody(draft.markdown, heading) === null) problems.push(`нет раздела «${heading}»`);
  }
  const unknown = stepToolNames(draft.markdown)
    .filter((name) => !knownToolNames.has(name) && !EVE_BUILTIN_TOOL_NAMES.has(name));
  if (unknown.length > 0) {
    problems.push(`в шагах названы инструменты, которых нет в этом режиме: ${unknown.join(", ")}`);
  }
  // An image skill without a prompt template makes the model translate a Russian paragraph into a
  // Flux prompt on every run; the template belongs in a reference file.
  if (stepToolNames(draft.markdown).includes("generate_image") && Object.keys(draft.files).length === 0) {
    problems.push("навык с generate_image должен нести references/<имя>.md с английским шаблоном промпта");
  }
  const mentioned = new Set(draft.markdown.match(REFERENCE_MENTION_PATTERN) ?? []);
  for (const path of mentioned) {
    if (!(path in draft.files)) problems.push(`markdown ссылается на ${path}, а файл не передан`);
  }
  const texts = [draft.markdown, ...Object.values(draft.files)];
  if (texts.some((text) => UNTRUSTED_BLOCK_PATTERN.test(text))) {
    problems.push("в тексте есть служебный блок недоверенного контекста; перескажи своими словами");
  }
  if (texts.some((text) => SECRET_PATTERN.test(text))) {
    problems.push("в тексте есть строка, похожая на ключ или токен; навык не хранит секреты");
  }
  return problems;
}

const SKILL_MAX_LINES = 150;

/**
 * Advisory checklist: a skill that fails these still publishes, but the owner and the author see
 * why it may load or run worse than it could.
 */
function rubricWarnings(draft: AuthoredSkillDraft): string[] {
  const warnings: string[] = [];
  if (sectionBody(draft.markdown, "## Когда не применять") === null) {
    warnings.push("нет раздела «Когда не применять»: без границ навык будут загружать не по делу");
  }
  const steps = sectionBody(draft.markdown, "## Шаги") ?? "";
  const stepLines = steps.split("\n").filter((line) => /^\s*(?:\d+[.)]|[-*])\s+/u.test(line));
  if (stepLines.length < 2) warnings.push("в «Шагах» меньше двух пунктов: навык не описывает порядок действий");
  if (!/[,;]|\bили\b/iu.test(draft.description)) {
    warnings.push("description без косвенных формулировок: перечисли через запятую, по каким ещё просьбам навык нужен");
  }
  if (draft.markdown.split("\n").length > SKILL_MAX_LINES) {
    warnings.push(`markdown длиннее ${SKILL_MAX_LINES} строк: объёмное вынеси в references/`);
  }
  return warnings;
}

export interface AuthoredSkillRubricReport {
  /** Concrete trust or structure failures; a draft with any of them is refused. */
  blocking: string[];
  /** Quality hints; the draft still publishes, the owner sees them in the result. */
  warnings: string[];
}

/** The explicit checklist: blocking items refuse, warnings only inform. */
export function rubricChecklist(
  draft: AuthoredSkillDraft,
  knownToolNames: ReadonlySet<string>,
): AuthoredSkillRubricReport {
  return { blocking: rubricProblems(draft, knownToolNames), warnings: rubricWarnings(draft) };
}

/**
 * Validates a publish payload. Name and size problems are terminal for the payload; rubric
 * problems are retryable because the model can fix the text and call again. Returns the advisory
 * warnings of a draft that passed.
 */
export function assertAuthoredSkillDraft(
  draft: AuthoredSkillDraft,
  options: { knownToolNames: ReadonlySet<string> },
): string[] {
  if (!AUTHORED_SKILL_NAME_PATTERN.test(draft.name)) {
    throw new AppError(
      "AGENT_SKILL_NAME_INVALID",
      "Имя навыка: 2–40 символов, строчные латинские буквы, цифры и дефис, начинается с буквы или цифры",
    );
  }
  if (isReservedSkillName(draft.name)) {
    throw new AppError("AGENT_SKILL_NAME_RESERVED", `Имя ${draft.name} занято встроенным навыком`);
  }
  if (draft.trialSummary.trim().length === 0) {
    throw new AppError(
      "AGENT_SKILL_TRIAL_MISSING",
      "Перед публикацией выполни навык на одном реальном примере и опиши результат в trialSummary",
    );
  }
  if (draft.changeNote.trim().length === 0) {
    throw new AppError("AGENT_SKILL_CHANGE_NOTE_MISSING", "Опиши в changeNote, что изменилось и зачем");
  }
  const sizes = sizeProblems(draft);
  if (sizes.length > 0) {
    throw new AppError("AGENT_SKILL_CONTENT_TOO_LARGE", `Навык не проходит по размеру: ${sizes.join("; ")}`);
  }
  const rubric = rubricChecklist(draft, options.knownToolNames);
  if (rubric.blocking.length > 0) {
    throw new AppError("AGENT_SKILL_RUBRIC_FAILED", `Навык не проходит рубрику: ${rubric.blocking.join("; ")}`);
  }
  return rubric.warnings;
}

/** Rubric for stored content re-read against the current tool catalog (rollback). */
export function assertStoredSkillContent(
  content: { description: string; files: Readonly<Record<string, string>>; markdown: string; name: string },
  knownToolNames: ReadonlySet<string>,
): string[] {
  const rubric = rubricChecklist({ ...content, changeNote: "-", trialSummary: "-" }, knownToolNames);
  if (rubric.blocking.length > 0) {
    throw new AppError(
      "AGENT_SKILL_RUBRIC_FAILED",
      `Эта версия больше не проходит рубрику в текущем режиме: ${rubric.blocking.join("; ")}`,
    );
  }
  return rubric.warnings;
}
