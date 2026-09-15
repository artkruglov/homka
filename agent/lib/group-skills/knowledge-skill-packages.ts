/**
 * Analyst skills as dynamic packages for external groups.
 *
 * Exports:
 * - `KNOWLEDGE_SKILL_DEFINITIONS`: `auto-analyst` and `policy-finance-analyst` read once from
 *   `agent/skills/<name>/` (SKILL.md body plus every `references/*.md`).
 * - `knowledgeSkills`: the packages an external turn materializes with the live `web_search` grant.
 *
 * Key construct:
 * - Eve compiles `agent/skills/<name>/SKILL.md` as static skills, but the public `load_skill`
 *   executor the external wrapper delegates to is created with an empty static list and resolves
 *   only dynamic packages of the session. The analyst skills therefore have to reach the external
 *   sandbox as packages, exactly like `imagegen`; before this they failed with
 *   AGENT_TOOL_DEPENDENCY_FAILED ("No skill named ...") on every call from a group.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineSkill, type SkillDefinition } from "eve/skills";

import { AppError } from "../app-error.js";
import { KNOWLEDGE_SKILL_NAMES, type KnowledgeSkillName } from "./knowledge-skills.js";

const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u;
const DESCRIPTION_PATTERN = /^description:\s*(.+?)\s*$/mu;

function loadDefinition(name: KnowledgeSkillName): SkillDefinition {
  // Like the trusted Google packages: the working directory first (the production image and the
  // e2e agent, which copies these directories next to `config`), the source tree as a fallback for
  // tools run from elsewhere. `import.meta.url` alone is wrong inside an Eve build bundle.
  const fromCwd = resolve(`agent/skills/${name}`);
  const root = existsSync(`${fromCwd}/SKILL.md`) ? fromCwd : fileURLToPath(new URL(`../../skills/${name}/`, import.meta.url));
  const source = readFileSync(`${root}/SKILL.md`, "utf8");
  const frontmatter = FRONTMATTER_PATTERN.exec(source);
  const description = frontmatter === null ? undefined : DESCRIPTION_PATTERN.exec(frontmatter[1])?.[1];
  if (frontmatter === null || !description) {
    throw new AppError("AGENT_KNOWLEDGE_SKILL_INVALID", `Некорректный пакет навыка-аналитика: ${name}`);
  }
  const files: Record<string, string> = {};
  for (const entry of readdirSync(`${root}/references`)) {
    if (entry.endsWith(".md")) files[`references/${entry}`] = readFileSync(`${root}/references/${entry}`, "utf8");
  }
  return defineSkill({ description, files, markdown: frontmatter[2].trimStart() });
}

export const KNOWLEDGE_SKILL_DEFINITIONS: Readonly<Record<KnowledgeSkillName, SkillDefinition>> =
  Object.fromEntries(KNOWLEDGE_SKILL_NAMES.map((name) => [name, loadDefinition(name)])) as Record<KnowledgeSkillName, SkillDefinition>;

export function knowledgeSkills(): Record<string, SkillDefinition> {
  return { ...KNOWLEDGE_SKILL_DEFINITIONS };
}
