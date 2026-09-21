/** Does the model capture and close tasks the way the task contract asks? Paid live probe.
 * MODEL_API_KEY=… npx tsx stress/prompt-evals/task-requests.ts --out .tmp/evals/tasks-1 --max-requests 30 [--samples 2] [--reasoning-none] [--dry]
 * Refuses above --max-requests and sends requests one at a time to share the cached prefix.
 *
 * 19–21 September 2026, production: a list dictated in the family group never became tasks, and
 * "закрой этим задачи" in private turned into 18 reads of the registry without one complete. The
 * cases below are those real messages plus the two group stories of docs/task-user-stories.ru.md.
 * `manage_shared_tasks` is declared, not executed: every call gets a stub result, up to three steps.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";

import manageSharedTasks from "../../agent/lib/tools/manage_shared_tasks.ts";
import { modeInstructions } from "../../agent/lib/prompt/mode-instructions.ts";
import { sharedTaskInput } from "../../agent/lib/shared-tasks.ts";
import { createConfiguredLanguageModel } from "../../agent/lib/model-transport.ts";
import { modelProviderConfig } from "../../agent/lib/model-provider-config.ts";

const argument = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const out = argument("out") ?? ".tmp/evals/task-requests";
const samples = Number(argument("samples") ?? "2");
const maxRequests = Number(argument("max-requests"));
const MAX_STEPS = 3;

interface Call { input: Record<string, unknown>; tool: string; valid: boolean }
interface Case {
  environment: "family" | "private";
  expect: (calls: readonly Call[], finalText: string) => string | null;
  key: string;
  message: string;
}

// Реестр по образцу прода 21 сентября (названия обезличены): то, что модель увидит в list.
const REGISTRY = [
  { id: "6cd4c57b-34bd-4c64-a882-b973bb577c62", title: "Отправить документы в банк: паспорт, СНИЛС и справки" },
  { id: "339b444f-a64d-45fa-b593-b95a8194ada8", title: "Сканировать документы" },
  { id: "3c650029-e0f0-4604-af66-6b1268ea01ce", title: "Назначить встречу с Олегом по стратегии" },
  { id: "aa70d3d7-03d3-434d-8955-8d2e5082e1a6", title: "Встреча с Олегом — четверг следующей недели" },
  { id: "5f0e0f7c-1a1a-4b1b-8c1c-000000000001", title: "Отвезти Опель на ремонт и зарядить его" },
  { id: "5f0e0f7c-1a1a-4b1b-8c1c-000000000002", title: "Найти репетитора по математике для сына" },
].map((task, index) => ({ ...task, kind: "task", source: "Личное", status: "accepted", version: 2 + index % 2 }));

const reads = (calls: readonly Call[]) => calls.filter((call) => ["list", "lists", "get"].includes(String(call.input.action))).length;
const batchItems = (calls: readonly Call[], action: string) => calls
  .flatMap((call) => call.input.action === "batch" ? (call.input.items as Record<string, unknown>[]) : [call.input])
  .filter((item) => item.action === action);

const CASES: Case[] = [
  {
    environment: "private", key: "dictated-list",
    message: "Занеси в список дел. Нам нужно найти людей, кто которые повесят шторы. Нужно починить опель. Нужночи. Починить и продать опель. Нужно. Нужно аккумулятор. Аккумулятор нужно зарядить опеля.. Нужно матрасы свести отвезти Матрас и свет увести в новую квартиру. Найти репетитора по математике для сына.",
    expect: (calls) => {
      const creates = batchItems(calls, "create").length;
      const batches = calls.filter((call) => call.input.action === "batch").length;
      return batches === 1 && creates >= 4 ? null : `batches=${batches} creates=${creates}`;
    },
  },
  {
    environment: "private", key: "unclear-close",
    message: "а я это уже сделал - закрой этим задачи - и у меня есть еще больше дел есть ведьъъ",
    expect: (calls, text) => {
      const closed = batchItems(calls, "complete").length;
      // Уточнение может быть вопросом или просьбой назвать дела: важно, что ничего не закрыто и реестр не перебирался.
      return reads(calls) <= 1 && closed === 0 && text.trim().length > 0 ? null : `reads=${reads(calls)} closed=${closed}`;
    },
  },
  {
    environment: "private", key: "explicit-close",
    message: "Отправку документов и встречу с Олегом я сделал, закрой их",
    // Решение владельца 21 сентября: закрыть все подходящие дела одним вызовом и перечислить их,
    // ошибку исправит reopen. Названные два обязаны быть среди закрытых, чужие дела трогать нельзя.
    expect: (calls, text) => {
      const ids = batchItems(calls, "complete").map((item) => String(item.id));
      const named = ["6cd4c57b-34bd-4c64-a882-b973bb577c62", "aa70d3d7-03d3-434d-8955-8d2e5082e1a6"];
      const related = new Set([...named, "339b444f-a64d-45fa-b593-b95a8194ada8", "3c650029-e0f0-4604-af66-6b1268ea01ce"]);
      const writes = calls.filter((call) => call.input.action === "batch" || call.input.action === "complete").length;
      const ok = named.every((id) => ids.includes(id)) && ids.every((id) => related.has(id)) && writes === 1 && reads(calls) <= 1 && text.trim().length > 0;
      return ok ? null : `closed=${ids.length} writes=${writes} reads=${reads(calls)}`;
    },
  },
  {
    environment: "family", key: "who-takes",
    message: "Надо заказать фильтры, кто возьмёт?",
    expect: (calls) => batchItems(calls, "create").some((item) => item.unassigned === true) ? null : "no unassigned create",
  },
  {
    environment: "family", key: "chatter",
    message: "ок, спасибо",
    expect: (calls, text) => calls.length === 0 && text.trim() === "<telegram-silent>" ? null : `calls=${calls.length} text=${text.slice(0, 60)}`,
  },
];

const caseCount = argument("cases")?.split(",").length ?? CASES.length;
const planned = caseCount * samples * MAX_STEPS;
console.error(`paid requests planned: up to ${planned} (${caseCount} cases × ${samples} samples × ≤${MAX_STEPS} steps; cached cells are skipped); about 30k input tokens each, mostly cached`);
if (process.argv.includes("--dry")) process.exit(0);
if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) throw new Error("AGENT_EVAL_MAX_REQUESTS_REQUIRED");
if (planned > maxRequests) throw new Error(`AGENT_EVAL_REQUEST_CAP_EXCEEDED: ${planned} > ${maxRequests}`);
const apiKey = process.env.MODEL_API_KEY;
if (!apiKey) throw new Error("AGENT_EVAL_MODEL_KEY_MISSING");
// Production runs with thinking disabled; `--reasoning-none` reproduces it.
const transport = process.argv.includes("--reasoning-none")
  ? { ...modelProviderConfig.agent.transport, reasoning: { type: "none" as const } }
  : modelProviderConfig.agent.transport;
const model = createConfiguredLanguageModel({ apiKey, maxOutputTokens: 16_000, modelId: modelProviderConfig.agent.models.primary.id, transport });
const core = await readFile("agent/instructions.md", "utf8");
const tool = {
  description: manageSharedTasks.description,
  inputSchema: z.toJSONSchema(sharedTaskInput, { io: "input" }) as never,
  name: "manage_shared_tasks",
  type: "function" as const,
};

function userMessage(testCase: Case): string {
  if (testCase.environment === "private") return testCase.message;
  const current = { sourceSequence: "41", senderDisplayName: "Анна", senderUsername: "anna", triggeredBy: "unaddressed", text: testCase.message };
  return `<current_telegram_message>\n${JSON.stringify(current)}\n</current_telegram_message>`;
}

// Заглушка проверяет вход настоящей схемой: поле, которое инструмент отверг бы, считается ошибкой.
function stubResult(input: Record<string, unknown>, environment: Case["environment"]): unknown {
  const parsed = sharedTaskInput.safeParse(input);
  if (!parsed.success) return { error: { code: "AGENT_TASK_INPUT_INVALID", message: parsed.error.issues.map((issue) => issue.message).join("; ") } };
  const source = environment === "family" ? "Семья" : "Личное";
  // Как репозиторий: в личке нет свободных дел и поручений другому, пакет с таким пунктом отклоняется целиком.
  const items = input.action === "batch" ? input.items as Record<string, unknown>[] : [input];
  const personalDenied = environment === "private" ? items.findIndex((item) => item.unassigned === true || item.assigneeRef !== undefined) : -1;
  if (personalDenied >= 0) {
    return { error: { code: input.action === "batch" ? "AGENT_TASK_BATCH_REJECTED" : "AGENT_TASK_ACCESS_DENIED",
      message: `Пакет не применён, ничего не изменено. Не прошли пункты: #${personalDenied + 1} AGENT_TASK_ACCESS_DENIED` } };
  }
  if (input.action === "list") return { incomplete: false, nextCursor: null, tasks: REGISTRY, truncated: false };
  if (input.action === "batch") {
    return { replayed: false, tasks: (input.items as Record<string, unknown>[]).map((item, index) => ({
      id: item.id ?? `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, source,
      status: item.action === "create" ? (item.unassigned ? "open" : "accepted") : "completed", title: item.title ?? "дело" })) };
  }
  return { replayed: false, task: { id: input.id ?? "00000000-0000-4000-8000-000000000099", source, status: "accepted", title: input.title ?? "дело" } };
}

const hasError = (value: unknown) => typeof value === "object" && value !== null && "error" in value;

interface Cell { calls: Call[]; error?: string; failure: string | null; text: string }
async function run(testCase: Case): Promise<Cell> {
  const system = `${core}\n\n${modeInstructions({ environment: testCase.environment })}`;
  const prompt: unknown[] = [
    { content: system, role: "system" },
    { content: [{ text: userMessage(testCase), type: "text" }], role: "user" },
  ];
  const calls: Call[] = [];
  let text = "";
  for (let step = 0; step < MAX_STEPS; step += 1) {
    const result = await model.doGenerate({
      abortSignal: AbortSignal.timeout(300_000), maxOutputTokens: 16_000, prompt: prompt as never,
      toolChoice: { type: "auto" }, tools: [tool],
    });
    const toolCalls = result.content.flatMap((part) => part.type === "tool-call" ? [part] : []);
    text = result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
    if (toolCalls.length === 0) break;
    prompt.push({ content: toolCalls.map((call) => ({ input: JSON.parse(call.input), toolCallId: call.toolCallId, toolName: call.toolName, type: "tool-call" })), role: "assistant" });
    prompt.push({ content: toolCalls.map((call) => {
      const input = JSON.parse(call.input) as Record<string, unknown>;
      calls.push({ input, tool: call.toolName, valid: sharedTaskInput.safeParse(input).success });
      return { output: { type: "json", value: stubResult(input, testCase.environment) }, toolCallId: call.toolCallId, toolName: call.toolName, type: "tool-result" };
    }), role: "tool" });
  }
  const invalid = calls.filter((call) => !call.valid || hasError(stubResult(call.input, testCase.environment))).length;
  return { calls, failure: invalid > 0 ? `invalid calls=${invalid}` : testCase.expect(calls, text), text };
}

await mkdir(out, { mode: 0o700, recursive: true });
const path = `${out}/results.json`;
const results: Record<string, Cell[]> = await readFile(path, "utf8").then(JSON.parse).catch(() => ({}));
// --cases a,b прогоняет только выбранные случаи.
const only = argument("cases")?.split(",");
const selected = only ? CASES.filter((testCase) => only.includes(testCase.key)) : CASES;
for (const testCase of selected) {
  for (let sample = 0; sample < samples; sample += 1) {
    const cells = results[testCase.key] ??= [];
    if (cells[sample] && !cells[sample]!.error) continue;
    try { cells[sample] = await run(testCase); }
    catch (error) { cells[sample] = { calls: [], error: String(error).slice(0, 300), failure: "error", text: "" }; }
    const cell = cells[sample]!;
    console.error(`${testCase.key}#${sample} ${cell.failure === null ? "PASS" : `FAIL ${cell.failure}`}`);
    await writeFile(path, JSON.stringify(results, null, 1), { mode: 0o600 });
  }
}
for (const testCase of selected) {
  const cells = results[testCase.key] ?? [];
  console.log(`${testCase.key}: ${cells.filter((cell) => cell.failure === null).length}/${cells.length} pass`);
}
