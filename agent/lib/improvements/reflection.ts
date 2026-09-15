/**
 * Post-turn reflection: one bounded model call that turns turn evidence into backlog items.
 *
 * Exports:
 * - `reflectOnTurn`: builds the prompt from application facts only, calls the model, parses a
 *   strict JSON list; anything unparsable is an empty list with a log line.
 * - `createReflectionRateLimiter`: at most N reflections per family per hour.
 *
 * The prompt asks about Mia and her tools, never about people: the evidence carries no message
 * text, so the answer cannot be steered from a chat.
 */
import { generateText } from "ai";

import { primaryModel } from "../model-registry.js";
import type { ImprovementPriority } from "./improvement-backlog-repository.js";
import {
  improvementFingerprint,
  type ImprovementCategory,
  type TurnEvidence,
} from "./turn-evidence.js";

export const REFLECTIONS_PER_FAMILY_PER_HOUR = 6;
const REFLECTION_TIMEOUT_MILLISECONDS = 60_000;
const MAX_ITEMS_PER_REFLECTION = 3;
const SUMMARY_MAX_CHARACTERS = 400;
const CATEGORIES = new Set<ImprovementCategory>(["memory", "other", "prompt", "tool_error", "workflow"]);
const PRIORITIES = new Set<ImprovementPriority>(["high", "low", "medium"]);

export interface ReflectionItem {
  category: ImprovementCategory;
  errorCode: string | null;
  fingerprint: string;
  priority: ImprovementPriority;
  summary: string;
  toolName: string | null;
}

export interface ReflectionInput {
  chatKind: "external" | "family" | "private";
  evidence: TurnEvidence;
}

export type ReflectionGenerate = (prompt: string) => Promise<string>;

export function buildReflectionPrompt(input: ReflectionInput): string {
  const facts = {
    chatKind: input.chatKind,
    failedTools: input.evidence.failedTools,
    loadedSkills: input.evidence.loadedSkills,
    stepCount: input.evidence.stepCount,
    toolNames: input.evidence.toolNames,
    turnFailure: input.evidence.turnFailure,
  };
  return [
    "Ты Telegram-ассистент семьи. Ниже факты об одном твоём ходе: какие инструменты ты вызывала, какие навыки загружала, какие инструменты упали с каким кодом, сколько шагов заняла работа и упал ли ход целиком. Текста сообщений людей здесь нет и он не нужен.",
    "Задача: решить, есть ли в этих фактах повторяемая проблема твоей работы, которую стоит записать в бэклог улучшений для владельца. Пиши про себя и свои инструменты, промпты, память и порядок действий, не про людей. Не выдумывай причин, которых не видно в фактах; если проблема разовая или объяснима (например, пользователь отменил подтверждение), верни пустой список.",
    "Категории: tool_error (инструмент падает или возвращает не то), prompt (инструкции не покрывают ситуацию), memory (память подвела), workflow (слишком много шагов, лишние вызовы, зацикливание), other.",
    `Верни только JSON без пояснений: {"items":[{"category":"tool_error","toolName":"generate_image","errorCode":"AGENT_IMAGE_PROVIDER_FAILED","summary":"Одно предложение: что не так и что стоит поправить","priority":"medium"}]}. До ${MAX_ITEMS_PER_REFLECTION} пунктов, summary до ${SUMMARY_MAX_CHARACTERS} символов, toolName и errorCode только если они есть в фактах, иначе null.`,
    `Факты: ${JSON.stringify(facts)}`,
  ].join("\n\n");
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function parseReflection(text: string, evidence: TurnEvidence): ReflectionItem[] {
  const parsed = extractJson(text) as { items?: unknown } | null;
  if (!parsed || !Array.isArray(parsed.items)) return [];
  const knownTools = new Set(evidence.toolNames);
  const knownCodes = new Set([
    ...evidence.failedTools.map((failure) => failure.code),
    ...(evidence.turnFailure ? [evidence.turnFailure.code] : []),
  ]);
  const items: ReflectionItem[] = [];
  for (const raw of parsed.items.slice(0, MAX_ITEMS_PER_REFLECTION)) {
    if (!raw || typeof raw !== "object") continue;
    const candidate = raw as Record<string, unknown>;
    const category = candidate.category;
    const priority = candidate.priority;
    const summary = typeof candidate.summary === "string" ? candidate.summary.trim() : "";
    if (!CATEGORIES.has(category as ImprovementCategory) || !PRIORITIES.has(priority as ImprovementPriority)) continue;
    if (summary.length === 0) continue;
    // A tool or code the evidence never named is the model's guess, not a fact: drop it.
    const toolName = typeof candidate.toolName === "string" && knownTools.has(candidate.toolName)
      ? candidate.toolName
      : null;
    const errorCode = typeof candidate.errorCode === "string" && knownCodes.has(candidate.errorCode)
      ? candidate.errorCode
      : null;
    const clipped = summary.length > SUMMARY_MAX_CHARACTERS
      ? `${summary.slice(0, SUMMARY_MAX_CHARACTERS - 1)}…`
      : summary;
    items.push({
      category: category as ImprovementCategory,
      errorCode,
      fingerprint: improvementFingerprint({
        category: category as ImprovementCategory, errorCode, summary: clipped, toolName,
      }),
      priority: priority as ImprovementPriority,
      summary: clipped,
      toolName,
    });
  }
  return items;
}

export async function generateReflectionText(prompt: string): Promise<string> {
  const result = await generateText({
    abortSignal: AbortSignal.timeout(REFLECTION_TIMEOUT_MILLISECONDS),
    maxRetries: 0,
    model: primaryModel,
    prompt,
  });
  return result.text;
}

export async function reflectOnTurn(
  input: ReflectionInput,
  generate: ReflectionGenerate = generateReflectionText,
): Promise<ReflectionItem[]> {
  const text = await generate(buildReflectionPrompt(input));
  const items = parseReflection(text, input.evidence);
  if (items.length === 0 && text.trim().length > 0 && extractJson(text) === null) {
    console.warn(JSON.stringify({ code: "AGENT_IMPROVEMENT_REFLECTION_UNPARSED", characters: text.length }));
  }
  return items;
}

export function createReflectionRateLimiter(limitPerHour = REFLECTIONS_PER_FAMILY_PER_HOUR) {
  const windows = new Map<string, number[]>();
  return {
    /** Records the attempt and returns whether it is within the family's hourly budget. */
    admit(familyId: string, now: Date = new Date()): boolean {
      const since = now.getTime() - 3_600_000;
      const recent = (windows.get(familyId) ?? []).filter((at) => at > since);
      if (recent.length >= limitPerHour) {
        windows.set(familyId, recent);
        return false;
      }
      recent.push(now.getTime());
      windows.set(familyId, recent);
      return true;
    },
  };
}
