/**
 * Blind comparison of prompt variants on real turns.
 *
 * Usage:
 *   MODEL_API_KEY=… npx tsx stress/prompt-evals/compare.ts --inputs .tmp/evals/group-inputs.json \
 *     --variants stress/prompt-evals/variants.example.json --out .tmp/evals/run-1 [--samples 2] [--dry]
 *
 * A variant is the production prompt of a mode plus optional edits: a section appended after the
 * mode block, an exact replacement inside the core, a different model or effort. Memory records
 * for the context go in `--memories` (JSON array of records as `search_memories` returns them);
 * the harness picks the three closest by word overlap for every turn. The run writes results.json
 * (resumable: failed cells rerun), report.html with columns shuffled per row, key.json with the
 * column order, and prints length, directive, silence and error rates per variant.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { generateText } from "ai";

import { formatRetrievedMemoryInstructions, MEMORY_USED_REMINDER } from "../../agent/lib/memory-retrieval.ts";
import { modeInstructions } from "../../agent/lib/prompt/mode-instructions.ts";
import { createConfiguredLanguageModel } from "../../agent/lib/model-transport.ts";

interface Variant {
  appendSection?: string;
  coreReplace?: [string, string];
  effort?: "none" | "low" | "high" | "max";
  key: string;
  label: string;
  mode?: "external" | "family" | "private";
  modelId?: string;
}
interface Input { actual: string | null; at: string; message: string; turn: string }
interface Cell { ms: number; text: string }

const args = new Map<string, string>();
const flags = new Set<string>();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index]!;
  if (!arg.startsWith("--")) continue;
  const next = process.argv[index + 1];
  if (next === undefined || next.startsWith("--")) flags.add(arg.slice(2));
  else { args.set(arg.slice(2), next); index += 1; }
}
const required = (name: string) => {
  const value = args.get(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
};
const inputsPath = required("inputs");
const variantsPath = required("variants");
const out = required("out");
const samples = Number(args.get("samples") ?? 2);
const dry = flags.has("dry");
const apiKey = process.env.MODEL_API_KEY;
if (!dry && !apiKey) throw new Error("MODEL_API_KEY missing: take it from the production .env, never commit it");

const EXTERNAL_CAPABILITIES = new Set(["inspect_workspace_image", "list_memories", "list_memory_threads", "read_memory_thread", "remember", "search_memories", "search_memory_threads", "web_fetch", "web_search"] as const);
const core = await readFile("agent/instructions.md", "utf8");
const inputs = JSON.parse(await readFile(inputsPath, "utf8")) as Input[];
const variants = JSON.parse(await readFile(variantsPath, "utf8")) as Variant[];
const memories = args.has("memories")
  ? JSON.parse(await readFile(args.get("memories")!, "utf8")) as Record<string, unknown>[]
  : [];

function systemPrompt(variant: Variant): string {
  const mode = variant.mode ?? "external";
  const modeBlock = mode === "external"
    ? modeInstructions({ capabilities: EXTERNAL_CAPABILITIES as never, environment: "external", reactionPolicy: { allowsAll: true, emoji: [] } })
    : modeInstructions({ environment: mode, reactionPolicy: { allowsAll: true, emoji: [] } });
  let coreText = core;
  if (variant.coreReplace) {
    const [from, to] = variant.coreReplace;
    if (!coreText.includes(from)) throw new Error(`variant ${variant.key}: core anchor not found`);
    coreText = coreText.replace(from, to);
  }
  return [coreText, modeBlock, variant.appendSection ?? ""].filter((part) => part.length > 0).join("\n\n");
}
const words = (text: string) => new Set(text.toLowerCase().match(/[а-яёa-z]{4,}/gu) ?? []);
function memoryContext(message: string): string | null {
  if (memories.length === 0) return null;
  const query = words(message);
  const picked = memories
    .map((record) => ({ record, score: [...words(String(record.content ?? ""))].filter((word) => query.has(word)).length }))
    .sort((a, b) => b.score - a.score).slice(0, 3).map((entry) => entry.record);
  return `${formatRetrievedMemoryInstructions(picked as never, { threads: [], totalCharacters: 0 } as never)}\n${MEMORY_USED_REMINDER}`;
}
function model(variant: Variant) {
  return createConfiguredLanguageModel({
    apiKey: apiKey ?? "dry",
    maxOutputTokens: 32_000,
    modelId: variant.modelId ?? "deepseek-v4-flash",
    transport: { baseUrl: "https://api.deepseek.com", protocol: "deepseek-responses", reasoning: { effort: variant.effort ?? "max" } } as never,
  });
}

await mkdir(out, { recursive: true });
const resultsPath = `${out}/results.json`;
const results: Record<string, Record<string, Cell[]>> = await readFile(resultsPath, "utf8").then((raw) => JSON.parse(raw)).catch(() => ({}));
if (dry) {
  for (const variant of variants) console.log(`${variant.key} ${variant.label}: system ${systemPrompt(variant).length} chars`);
  console.log(`inputs ${inputs.length}, memories ${memories.length}, samples ${samples}`);
  process.exit(0);
}
const jobs = inputs.flatMap((input) => variants.flatMap((variant) => Array.from({ length: samples }, (_, sample) => ({ input, sample, variant }))));
let cursor = 0;
async function worker() {
  while (cursor < jobs.length) {
    const job = jobs[cursor++]!;
    const cells = (results[job.input.turn] ??= {})[job.variant.key] ??= [];
    if (cells[job.sample] && !cells[job.sample]!.text.startsWith("⚠")) continue;
    const started = Date.now();
    const context = memoryContext(job.input.message);
    try {
      const result = await generateText({
        abortSignal: AbortSignal.timeout(240_000),
        maxRetries: 1,
        messages: [...(context ? [{ content: context, role: "user" as const }] : []), { content: job.input.message, role: "user" as const }],
        model: model(job.variant) as never,
        system: systemPrompt(job.variant),
      });
      cells[job.sample] = { ms: Date.now() - started, text: result.text.trim() };
    } catch (error) {
      cells[job.sample] = { ms: Date.now() - started, text: `⚠ ${error instanceof Error ? error.message.slice(0, 200) : String(error)}` };
    }
    console.error(`${job.input.turn} ${job.variant.key}#${job.sample} ${cells[job.sample]!.ms}ms`);
    await writeFile(resultsPath, JSON.stringify(results, null, 1));
  }
}
await Promise.all(Array.from({ length: 6 }, worker));

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function currentText(message: string) {
  const block = message.match(/<current_telegram_message>([\s\S]*?)<\/current_telegram_message>/)?.[1] ?? "";
  try { const parsed = JSON.parse(block.trim()); return `${parsed.senderDisplayName}: ${parsed.text}`; } catch { return block.slice(0, 300); }
}
const key: Record<string, string[]> = {};
const columns = [...variants.map((variant) => variant.key), "actual"];
const rows = inputs.map((input, index) => {
  const order = [...columns].sort(() => Math.random() - 0.5);
  key[input.turn] = order;
  const cells = order.map((column, position) => {
    const texts = column === "actual" ? [input.actual ?? ""] : (results[input.turn]?.[column] ?? []).map((cell) => cell.text);
    return `<td><div class="tag">${position + 1}</div>${texts.map((text) => `<div class="txt">${escape(text)}</div>`).join("<hr>")}</td>`;
  }).join("");
  return `<tr><td class="q">${index + 1}. ${escape(currentText(input.message))}</td>${cells}</tr>`;
}).join("\n");
await writeFile(`${out}/report.html`, `<!doctype html><meta charset="utf-8"><title>Слепое сравнение промптов</title>
<style>body{font:14px/1.4 system-ui;margin:16px}table{border-collapse:collapse;width:100%}td{vertical-align:top;border:1px solid #ddd;padding:8px}td.q{background:#f6f6f6;font-weight:600;white-space:pre-wrap}.tag{font-size:11px;color:#999}.txt{white-space:pre-wrap}</style>
<p>${inputs.length} реальных сообщений, колонки перемешаны в каждой строке; ключ в key.json.</p><table>${rows}</table>`);
await writeFile(`${out}/key.json`, JSON.stringify({ key, variants: Object.fromEntries(variants.map((variant) => [variant.key, variant.label])) }, null, 1));

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
for (const variant of variants) {
  const cells = inputs.flatMap((input) => results[input.turn]?.[variant.key] ?? []);
  const ok = cells.filter((cell) => !cell.text.startsWith("⚠"));
  const bodies = ok.map((cell) => cell.text.replace(/<memory-used>[^<]*<\/memory-used>/gu, "").trim());
  console.log(`${variant.key} ${variant.label}: n=${ok.length} errors=${cells.length - ok.length} median=${median(bodies.map((body) => body.length))} ` +
    `directive=${ok.filter((cell) => cell.text.includes("<memory-used>")).length} silent=${bodies.filter((body) => /telegram-silent|telegram-reaction/u.test(body) || body.length === 0).length}`);
}
