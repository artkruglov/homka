/** Search-only live probe, not full Eve/Telegram acceptance. Resume never reorders paid calls.
 * npm run eval:search -- --out .tmp/evals/search-v2 [--samples 1] [--dry]
 * A crashed run can leave run.lock: inspect its process before removing that lock manually.
 * started/failed cells are terminal for automatic resume; use a new directory for an explicit rerun.
 */
import { readFile, mkdir, writeFile, open, unlink, rename } from "node:fs/promises";
import { createConfiguredLanguageModel } from "../../agent/lib/model-transport.ts";
import { modelProviderConfig } from "../../agent/lib/model-provider-config.ts";
import { WEB_SEARCH_RULES } from "../../agent/lib/prompt/trusted-fragments.ts";
import { checkSearchAnswer, type SearchAnswerRule } from "../../agent/lib/answer-links/search-answer-checks.ts";
import { extractLinks } from "../../agent/lib/answer-links/answer-links.ts";
import { evaluateSearchModel, evaluationFingerprint } from "./model-run.ts";

interface Scenario { id: string; question: string; rules: SearchAnswerRule[]; why: string }
interface Cell {
  status: "started" | "completed" | "failed";
  startedAt: string;
  answer?: string;
  searchCalls?: number;
  searchErrorCodes?: string[];
  sources?: string[];
  evidenceFailure?: string | null;
  failed?: SearchAnswerRule[];
  linksWithoutProviderSource?: string[];
  ms?: number;
}
function argument(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}
async function optionalJson(path: string) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function atomicJson(path: string, value: unknown) {
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}
const out = argument("out") ?? ".tmp/evals/search-v2";
const samples = Number(argument("samples") ?? "1");
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 10) throw new Error("AGENT_EVAL_SAMPLES_INVALID");
const allScenarios: Scenario[] = JSON.parse(await readFile(new URL("./scenarios.json", import.meta.url), "utf8"));
const selectedScenario = argument("scenario");
const scenarios = selectedScenario ? allScenarios.filter(item => item.id === selectedScenario) : allScenarios;
if (scenarios.length === 0) throw new Error("AGENT_EVAL_SCENARIO_UNKNOWN");
if (process.argv.includes("--dry")) {
  console.log(JSON.stringify({ scope: "search-only; semantic and Telegram acceptance remain separate", scenarios }));
  process.exit(0);
}
const apiKey = process.env.MODEL_API_KEY;
if (!apiKey) throw new Error("AGENT_EVAL_MODEL_KEY_MISSING");
const transport = modelProviderConfig.agent.transport;
if (transport.protocol !== "anthropic-messages") throw new Error("AGENT_EVAL_SEARCH_TRANSPORT_UNSUPPORTED");
const modelId = argument("model") ?? modelProviderConfig.agent.models.primary.id;
const system = "Ты помогаешь семье. Отвечай по-русски. " + WEB_SEARCH_RULES +
  " Этот отдельный поисковый прогон предоставляет только web_search, без web_fetch. Не заявляй, что открыла страницу инструментом, которого здесь нет. Доступно не более трёх поисковых запросов; после них заверши ответ с полными ссылками на источники.";
const fingerprint = evaluationFingerprint({ version: 3, transport, modelId, system, scenarios });
await mkdir(out, { recursive: true, mode: 0o700 });
const lockPath = `${out}/run.lock`;
const lock = await open(lockPath, "wx", 0o600);
await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
try {
  const metadata = await optionalJson(`${out}/metadata.json`);
  const results: Record<string, Cell[]> = await optionalJson(`${out}/results.json`) ?? {};
  if (metadata ? metadata.fingerprint !== fingerprint : Object.keys(results).length !== 0) {
    throw new Error("AGENT_EVAL_REPORT_CONFIG_MISMATCH");
  }
  const startedAt = metadata?.startedAt ?? new Date().toISOString();
  if (!metadata) await atomicJson(`${out}/metadata.json`, {
    version: 3, fingerprint, startedAt, modelId, transport, system,
    scope: "search-only, not full agent acceptance; no URL availability or content validation",
  });
  const model = createConfiguredLanguageModel({ apiKey, maxOutputTokens: 8_000, modelId, transport });
  for (const scenario of scenarios) {
    const cells = results[scenario.id] ??= [];
    for (let sample = 0; sample < samples; sample += 1) {
      if (cells[sample]) continue;
      const started = Date.now();
      cells[sample] = { status: "started", startedAt: new Date().toISOString() };
      await atomicJson(`${out}/results.json`, results); // Before the only paid request.
      try {
        const evidence = await evaluateSearchModel(model, scenario.question, system + `\nВремя начала проверки: ${startedAt}.`);
        const report = checkSearchAnswer(evidence.answer, scenario.rules);
        cells[sample] = { ...cells[sample]!, ...evidence, status: "completed",
          failed: [...report.failed], ms: Date.now() - started,
          linksWithoutProviderSource: extractLinks(evidence.answer).filter(url => !evidence.sources.includes(url)),
        };
      } catch {
        cells[sample] = { ...cells[sample]!, status: "failed", evidenceFailure: "model_request_failed_or_ambiguous", ms: Date.now() - started };
      }
      await atomicJson(`${out}/results.json`, results);
      console.error(`${scenario.id}#${sample}: ${cells[sample]!.status}, evidence=${cells[sample]!.evidenceFailure ?? "present"}`);
    }
  }
  const rows = Object.entries(results).flatMap(([id, cells]) => cells.map(cell => ({ id, ...cell })));
  const summary = {
    runs: rows.length,
    incomplete: rows.filter(row => row.status !== "completed" || row.evidenceFailure).map(row => row.id),
    failedRules: rows.filter(row => row.failed?.length).map(row => row.id),
    linksWithoutProviderSource: rows.filter(row => row.linksWithoutProviderSource?.length).map(row => row.id),
    semanticReview: "required; links and executed search do not prove factual accuracy",
  };
  await atomicJson(`${out}/summary.json`, summary);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await lock.close();
  await unlink(lockPath);
}
