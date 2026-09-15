/**
 * Byte-preserving model credential environment transformation.
 *
 * Exports:
 * - `buildModelEnvironment`: replaces exact credential assignments and preserves all unknown bytes.
 * - `readModelCredentialPresence`: reports target assignment presence without exposing values.
 */
import { modelConfigError } from "./errors.js";

const MODEL_KEY = Buffer.from("MODEL_API_KEY=");
const GROQ_KEY = Buffer.from("GROQ_API_KEY=");
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const NUL = 0x00;

interface EnvironmentLine {
  readonly content: Buffer;
  readonly ending: Buffer;
}

interface ParsedTargets {
  readonly groqIndexes: number[];
  readonly lines: EnvironmentLine[];
  readonly modelIndexes: number[];
}

function targetName(content: Buffer): "groq" | "model" | undefined {
  // dotenv accepts optional leading whitespace and `export`; inspect only ASCII syntax, never values.
  const assignment = content.toString("latin1").match(
    /^[\t ]*(?:export[\t ]+)?(MODEL_API_KEY|GROQ_API_KEY)[\t ]*=/u,
  );
  if (assignment?.[1] === "MODEL_API_KEY") return "model";
  if (assignment?.[1] === "GROQ_API_KEY") return "groq";
  return undefined;
}

function splitLines(source: Buffer): EnvironmentLine[] {
  const lines: EnvironmentLine[] = [];
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== LINE_FEED) continue;
    const contentEnd = index > start && source[index - 1] === CARRIAGE_RETURN ? index - 1 : index;
    lines.push({ content: source.subarray(start, contentEnd), ending: source.subarray(contentEnd, index + 1) });
    start = index + 1;
  }
  if (start < source.length) lines.push({ content: source.subarray(start), ending: Buffer.alloc(0) });
  return lines;
}

function parseTargets(source: Buffer): ParsedTargets {
  const lines = splitLines(source);
  const modelIndexes: number[] = [];
  const groqIndexes: number[] = [];
  lines.forEach((line, index) => {
    const target = targetName(line.content);
    if (target === "model") modelIndexes.push(index);
    if (target === "groq") groqIndexes.push(index);
  });
  if (modelIndexes.length > 1 || groqIndexes.length > 1) {
    throw modelConfigError(
      "OSINARA_MODEL_CONFIG_ENV_DUPLICATE",
      "В .env обнаружены повторяющиеся MODEL_API_KEY или GROQ_API_KEY; удалите дубликаты и повторите операцию",
    );
  }
  return { groqIndexes, lines, modelIndexes };
}

function credentialBytes(value: string, name: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  if (!bytes.length || /[\s']/u.test(value) || bytes.includes(NUL)) {
    throw modelConfigError(
      "OSINARA_MODEL_CONFIG_CREDENTIAL_INVALID",
      `Обязательное значение ${name} пусто или содержит пробельные либо нулевые символы`,
    );
  }
  return Buffer.concat([Buffer.from("'"), bytes, Buffer.from("'")]);
}

function preferredEnding(lines: EnvironmentLine[]): Buffer {
  return lines.find((line) => line.ending.length > 0)?.ending ?? Buffer.from("\n");
}

export function buildModelEnvironment(source: Buffer, input: {
  readonly groqApiKey?: string;
  readonly modelApiKey: string;
}): Buffer {
  const parsed = parseTargets(source);
  const modelAssignment = Buffer.concat([
    MODEL_KEY,
    credentialBytes(input.modelApiKey, "MODEL_API_KEY"),
  ]);
  const groqAssignment = input.groqApiKey === undefined
    ? undefined
    : Buffer.concat([GROQ_KEY, credentialBytes(input.groqApiKey, "GROQ_API_KEY")]);
  const ending = preferredEnding(parsed.lines);
  const output: Buffer[] = [];

  // Existing target lines retain their original line ending; an omitted Groq credential removes stale access.
  parsed.lines.forEach((line, index) => {
    if (parsed.modelIndexes.includes(index)) {
      output.push(modelAssignment, line.ending);
      return;
    }
    if (parsed.groqIndexes.includes(index)) {
      if (groqAssignment) output.push(groqAssignment, line.ending);
      return;
    }
    output.push(line.content, line.ending);
  });

  // Missing assignments are appended without rewriting or decoding any unrelated source bytes.
  if (parsed.modelIndexes.length === 0 || groqAssignment && parsed.groqIndexes.length === 0) {
    if (output.length > 0 && !output.at(-1)?.equals(ending)) output.push(ending);
    if (parsed.modelIndexes.length === 0) output.push(modelAssignment, ending);
    if (groqAssignment && parsed.groqIndexes.length === 0) output.push(groqAssignment, ending);
  }
  return Buffer.concat(output);
}

export function readModelCredentialPresence(source: Buffer): {
  readonly groqApiKeyConfigured: boolean;
  readonly modelApiKeyConfigured: boolean;
} {
  const parsed = parseTargets(source);
  return {
    groqApiKeyConfigured: parsed.groqIndexes.length === 1,
    modelApiKeyConfigured: parsed.modelIndexes.length === 1,
  };
}
