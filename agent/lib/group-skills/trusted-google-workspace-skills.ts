/**
 * Trusted-only Google Workspace skill definitions.
 *
 * Exports:
 * - `TRUSTED_GOOGLE_WORKSPACE_SKILL_NAMES`: exact dynamic skill identifiers.
 * - `TRUSTED_GOOGLE_WORKSPACE_SKILL_DEFINITIONS`: packages available only in trusted modes.
 *
 * Static Eve discovery cannot filter authored skills by session. These packages therefore
 * keep their source outside `agent/skills`, then enter Eve only via the trusted dynamic resolver.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { defineSkill, type SkillDefinition } from "eve/skills";

import { AppError } from "../app-error.js";

export const TRUSTED_GOOGLE_WORKSPACE_SKILL_NAMES = [
  "gws-calendar",
  "gws-calendar-agenda",
  "gws-calendar-insert",
  "gws-docs",
  "gws-docs-write",
  "gws-drive",
  "gws-gmail",
  "gws-gmail-forward",
  "gws-gmail-read",
  "gws-gmail-reply",
  "gws-gmail-reply-all",
  "gws-gmail-send",
  "gws-gmail-triage",
  "gws-gmail-watch",
  "gws-people",
  "gws-shared",
  "gws-sheets",
  "gws-sheets-append",
  "gws-sheets-read",
] as const;

export type TrustedGoogleWorkspaceSkillName =
  (typeof TRUSTED_GOOGLE_WORKSPACE_SKILL_NAMES)[number];

const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u;
const NAME_PATTERN = /^name:\s*([^\s]+)\s*$/mu;
const DESCRIPTION_PATTERN = /^description:\s*"([^"]+)"\s*$/mu;

function loadDefinition(name: TrustedGoogleWorkspaceSkillName): SkillDefinition {
  const source = readFileSync(resolve(`config/trusted-skills/${name}/SKILL.md`), "utf8");
  const frontmatter = FRONTMATTER_PATTERN.exec(source);
  const sourceName = frontmatter === null ? undefined : NAME_PATTERN.exec(frontmatter[1])?.[1];
  const description = frontmatter === null
    ? undefined
    : DESCRIPTION_PATTERN.exec(frontmatter[1])?.[1];
  if (frontmatter === null || sourceName !== name || description === undefined) {
    throw new AppError(
      "AGENT_TRUSTED_GWS_SKILL_INVALID",
      `Некорректный trusted Google Workspace skill package: ${name}`,
    );
  }

  // Eve writes dynamic package markdown back as SKILL.md, preserving sibling cross-links.
  return defineSkill({ description, markdown: frontmatter[2].trimStart() });
}

export const TRUSTED_GOOGLE_WORKSPACE_SKILL_DEFINITIONS: Readonly<
  Record<TrustedGoogleWorkspaceSkillName, SkillDefinition>
> = Object.fromEntries(
  TRUSTED_GOOGLE_WORKSPACE_SKILL_NAMES.map((name) => [name, loadDefinition(name)]),
) as Record<TrustedGoogleWorkspaceSkillName, SkillDefinition>;
