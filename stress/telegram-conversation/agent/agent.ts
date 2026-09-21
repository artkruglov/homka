/**
 * Native Eve turns with a deterministic provider; every Telegram and application boundary is real.
 *
 * The script (see evals/conversation.eval.ts): external-group turns alternate a human and another
 * bot and only touch the group workspace; the private turn delegates to a child, runs Bash and
 * probes the personal workspace; the family turn runs Bash and probes the family workspace. One
 * external turn fails inside the model on purpose.
 *
 * Приёмка вдвоём (W23) продолжает тот же прогон настоящими прикладными инструментами: в семейной
 * группе заводится свободное дело, в личке владельца — напоминание, а второй взрослый читает свой
 * список из собственной лички. Доставку напоминания проверяет уже сам прогон, вызывая минутный
 * диспетчер: он не помнит ничего между вызовами, поэтому это и есть проверка «переживёт перезапуск».
 */
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
import { SESSION_MAX_COMPLETED_TURNS } from "../../../agent/config.js";

export const EXTERNAL_TURN_COUNT = SESSION_MAX_COMPLETED_TURNS + 4;
export const FAILING_ORDINAL = SESSION_MAX_COMPLETED_TURNS + 3;

function ordinalOf(marker: string): number {
  return Number(marker.slice(marker.lastIndexOf("-") + 1));
}

interface AcceptanceStep {
  readonly input: (results: readonly ToolResult[]) => Record<string, unknown>;
  readonly tool: string;
}

interface ToolResult {
  readonly isError?: boolean;
  readonly name: string;
  readonly output?: unknown;
}

/**
 * Сценарии приёмки вдвоём: ход идёт шагами, и каждый шаг вызывает ровно тот инструмент, который
 * проверяет. Вход следующего шага собирается из результата предыдущего — так проверяется, что
 * ссылка на участника или id дела действительно пришли из выдачи, а не придуманы сценарием.
 *
 * `reply` дописывает к ответу то, что человек увидел бы своими глазами: сквозной прогон судит по
 * доставленному тексту, а не по внутреннему результату инструмента.
 */
const ACCEPTANCE: Readonly<Record<string, {
  readonly reply?: (results: readonly ToolResult[]) => string;
  readonly steps: readonly AcceptanceStep[];
}>> = {
  "conversation-decision": {
    steps:[
      {input:()=>({action:"participants"}),tool:"manage_joint_decision"},
      {input:results=>({action:"create",title:"В воскресенье в парк",partnerRef:participantRef(results,"Spouse")}),tool:"manage_joint_decision"},
    ],
  },
  "conversation-consent": {
    steps:[
      {input:()=>({action:"list"}),tool:"manage_joint_decision"},
      {input:results=>{const d=(outputOf(results,0).decisions as {id:string;version:number}[])[0]!;
        return {action:"answer",id:d.id,version:d.version,choice:"agree"};},tool:"manage_joint_decision"},
    ],
    reply:results=>JSON.stringify(outputOf(results,1).decision),
  },
  "conversation-feedback": {
    steps:[
      {input:()=>({action:"list"}),tool:"manage_joint_decision"},
      {input:results=>{const d=(outputOf(results,0).decisions as {id:string;version:number}[])[0]!;
        return {action:"feedback",id:d.id,version:d.version,text:"Хочу прогулку без спешки"};},tool:"manage_joint_decision"},
    ],
  },
  "conversation-errand": {
    steps: [
      { input: () => ({action:"recipients"}), tool:"manage_errand" },
      { input: results => ({action:"create",mode:"send",brief:"Парки на выходные",
        recipientRef:(outputOf(results,0).recipients as {name:string;recipientRef:string}[]).find(p=>p.name==="Spouse")!.recipientRef}),tool:"manage_errand" },
      { input: results => ({action:"research",id:(outputOf(results,1).errand as {id:string}).id,version:1}),tool:"manage_errand" },
    ],
  },
  "conversation-answer": {
    steps: [
      {input:()=>({action:"list",view:"received"}),tool:"manage_errand"},
      {input:results=>({action:"share_answer",id:(outputOf(results,0).errands as {id:string}[])[0]!.id,
        resultVersion:1,text:"Выбираю парк у реки"}),tool:"manage_errand"},
    ],
  },
  "conversation-status": {
    steps:[{input:()=>({action:"list",view:"sent"}),tool:"manage_errand"}],
    reply:results=>JSON.stringify(outputOf(results,0).errands),
  },
  "conversation-assign": {
    steps: [
      { input: () => ({ action: "participants" }), tool: "manage_shared_tasks" },
      {
        input: (results) => ({
          action: "create",
          assigneeRef: participantRef(results, "Spouse"),
          title: "Записать сына к врачу",
        }),
        tool: "manage_shared_tasks",
      },
    ],
  },
  // T03: список дел без обращения в семейной группе, которая слышит все реплики, одним пакетом.
  "conversation-capture": {
    steps: [{
      input: () => ({ action: "batch", items: [
        { action: "create", title: "Повесить шторы" },
        { action: "create", title: "Продать опель" },
        { action: "create", title: "Отвезти матрас и свет" },
      ] }),
      tool: "manage_shared_tasks",
    }],
  },
  // T05/T06: из лички закрываются два дела, заведённые в группе, одним пакетом.
  "conversation-close": {
    steps: [
      { input: () => ({ action: "list" }), tool: "manage_shared_tasks" },
      {
        input: (results) => ({ action: "batch", items: [
          { action: "complete", id: taskId(results, "Повесить шторы") },
          { action: "complete", id: taskId(results, "Продать опель") },
        ] }),
        tool: "manage_shared_tasks",
      },
    ],
    reply: (results) => `closed=${tasksOf(results, 1).map((task) => task.title).join("|")}`,
  },
  "conversation-buy": {
    steps: [{
      input: () => ({ action: "add", listName: "Продукты", title: "Молоко" }),
      tool: "manage_shopping_list",
    }],
  },
  "conversation-done": {
    steps: [
      { input: () => ({ action: "list", view: "mine" }), tool: "manage_shared_tasks" },
      {
        input: (results) => ({ action: "complete", id: taskId(results, "Полить цветы") }),
        tool: "manage_shared_tasks",
      },
    ],
  },
  "conversation-list": {
    steps: [{ input: () => ({ action: "list", view: "promised" }), tool: "manage_shared_tasks" }],
    reply: (results) => `titles=${taskTitles(results).join("|")}`,
  },
  "conversation-personal": {
    steps: [{
      input: () => ({ action: "create", title: "Сходить к стоматологу" }),
      tool: "manage_shared_tasks",
    }],
  },
  "conversation-repeat": {
    steps: [{
      input: () => ({
        action: "create",
        dueOn: new Date().toISOString().slice(0, 10),
        repeat: { interval: 1, unit: "weekly" },
        title: "Полить цветы",
      }),
      tool: "manage_shared_tasks",
    }],
  },
  "conversation-task": {
    steps: [{
      input: () => ({ action: "create", title: "Кто заберёт посылку", unassigned: true }),
      tool: "manage_shared_tasks",
    }],
  },
};

function outputOf(results: readonly ToolResult[], index: number): Record<string, unknown> {
  const output = results[index]?.output;
  if (typeof output !== "object" || output === null) throw new Error("TEST_ACCEPTANCE_OUTPUT_MISSING");
  return output as Record<string, unknown>;
}

function participantRef(results: readonly ToolResult[], name: string): string {
  const participants = outputOf(results, 0).participants;
  if (!Array.isArray(participants)) throw new Error("TEST_ACCEPTANCE_PARTICIPANTS_MISSING");
  const found = participants.find((person) => (person as { name?: string }).name === name);
  const reference = (found as { participantRef?: string } | undefined)?.participantRef;
  if (!reference) throw new Error(`TEST_ACCEPTANCE_PARTICIPANT_UNKNOWN: ${name}`);
  return reference;
}

function tasksOf(results: readonly ToolResult[], index = 0): { id?: string; title?: string }[] {
  const tasks = outputOf(results, index).tasks;
  if (!Array.isArray(tasks)) throw new Error("TEST_ACCEPTANCE_TASKS_MISSING");
  return tasks as { id?: string; title?: string }[];
}

function taskTitles(results: readonly ToolResult[]): string[] {
  return tasksOf(results).map((task) => task.title ?? "?");
}

function taskId(results: readonly ToolResult[], title: string): string {
  const found = tasksOf(results).find((task) => task.title === title);
  if (!found?.id) throw new Error(`TEST_ACCEPTANCE_TASK_UNKNOWN: ${title}`);
  return found.id;
}

export default defineAgent({
  build: { externalDependencies: ["@workflow/world-postgres"] },
  experimental: { workflow: { world: "@workflow/world-postgres" } },
  model: mockModel(({ lastUserMessage, messages, toolResults, tools }) => {
    const marker = [...(lastUserMessage ?? "").matchAll(/conversation-[a-z]+-\d+/gu)].at(-1)?.[0];
    if (!marker) throw new Error("TEST_CURRENT_MESSAGE_MISSING");
    const scenario = ACCEPTANCE[marker.slice(0, marker.lastIndexOf("-")) as keyof typeof ACCEPTANCE];
    const child = lastUserMessage?.includes(`child:${marker}`) === true;
    // A trusted child inherits the parent's scope but never the root-only tools.
    if (child && tools.some((tool) => tool.name === "remember" || tool.name === "generate_image")) {
      throw new Error("TEST_CHILD_ROOT_AUTHORITY_LEAK");
    }
    if (marker === `conversation-probe-${FAILING_ORDINAL}`) throw new Error("TEST_MODEL_FAILURE");
    const last = toolResults.at(-1);
    if (last?.isError) throw new Error(`TEST_WORKSPACE_TOOL_FAILED: ${JSON.stringify(last)}`);
    if (scenario) {
      // Шаги считаются в пределах этого хода, а не сессии: в одном чате ходов несколько, и
      // результаты прежних лежат в том же промпте. Границей служит последнее сообщение человека
      // с этой меткой — всё, что после него, принадлежит текущему ходу.
      const boundary = messages.reduce(
        (found, message, index) => message.role === "user" && message.text.includes(marker) ? index : found,
        -1,
      );
      const done = messages.slice(boundary + 1).filter((message) => message.role === "tool").length;
      const applied = toolResults.slice(toolResults.length - done);
      const step = scenario.steps[done];
      if (step) {
        return { toolCalls: [{ input: step.input(applied), name: step.tool }] };
      }
      const suffix = scenario.reply ? ` ${scenario.reply(applied)}` : "";
      return `reply-${marker}${suffix}`;
    }
    const trusted = ordinalOf(marker) > EXTERNAL_TURN_COUNT;
    if (trusted && !child) {
      if (!toolResults.some((result) => result.name === "agent" && JSON.stringify(result.output).includes(`child-${marker}`))) {
        return { toolCalls: [{ name: "agent", input: { message: `child:${marker}` } }] };
      }
      if (!toolResults.some((result) => result.name === "bash" && JSON.stringify(result.output).includes(`BASH:${marker}`))) {
        return { toolCalls: [{ name: "bash", input: { command: `printf 'BASH:${marker}\\n'` } }] };
      }
    }
    if (!toolResults.some((result) => result.name === "probe_workspace" && result.output === marker)) {
      return { toolCalls: [{ name: "probe_workspace", input: { marker } }] };
    }
    return `${child ? "child" : "reply"}-${marker}`;
  }),
  modelContextWindowTokens: 1_000_000,
});
