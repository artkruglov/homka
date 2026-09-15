/**
 * Eve background-task origin auth patch tests.
 *
 * Constructs covered:
 * - A new turn captures its delivered verified caller independently from later HITL auth.
 * - Task creation freezes that caller into the durable task-run input.
 * - Every task-owned parent wake restores the frozen caller instead of reusing session-latest auth.
 * - Tasks created before the additive wire field fail closed with a null caller.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const runtimePaths = [
  "node_modules/eve/dist/src/context/keys.js",
  "node_modules/eve/dist/src/execution/workflow-steps.js",
  "node_modules/eve/dist/src/execution/dispatch-runtime-actions-shared.js",
  "node_modules/eve/dist/src/execution/tasks/parent/dispatch-task-step.js",
  "node_modules/eve/dist/src/execution/tasks/parent/delegate.js",
  "node_modules/eve/dist/src/execution/tasks/child/workflow.js",
  "node_modules/eve/dist/src/execution/tasks/child/steps.js",
] as const;

describe("Eve task origin auth patch", () => {
  it("carries the originating turn caller through every durable task wake", async () => {
    const [patch, keys, workflowSteps, dispatchShared, dispatchTask, delegate, childWorkflow, childSteps] = await Promise.all([
      readFile("scripts/apply-eve-patches.ts", "utf8"),
      ...runtimePaths.map((path) => readFile(path, "utf8")),
    ]);

    expect(patch).toContain("TurnOriginAuthKey");
    expect(keys).toContain("eve.turnOriginAuth");
    expect(workflowSteps).toContain("TurnOriginAuthKey");
    expect(workflowSteps).toContain("getHarnessEmissionState(s.state).turnId.length===0");
    expect(dispatchShared).toContain("turnOriginAuth");
    expect(dispatchTask).toContain("auth:i.turnOriginAuth??null");
    expect(delegate).toContain("parentAuth:n.auth");
    expect(childWorkflow).toContain("y=i.parentAuth??null");
    expect(childWorkflow.match(/auth:y/g)).toHaveLength(7);
    expect(childSteps.match(/auth:e\.auth/g)).toHaveLength(4);
  });

  it("captures auth only at a new turn boundary and ignores same-turn HITL auth", async () => {
    const source = await readFile(
      "node_modules/eve/dist/src/execution/workflow-steps.js",
      "utf8",
    );
    const expressionStart = source.indexOf("a.input?.kind===`deliver`&&(");
    const expressionEnd = source.indexOf(";let l=", expressionStart);
    if (expressionStart < 0 || expressionEnd < 0) {
      throw new Error("TEST_EVE_TURN_ORIGIN_AUTH_SHAPE_INVALID");
    }
    const applyDelivery = new Function(
      "a",
      "c",
      "s",
      "TurnTaskDeliveryKey",
      "TurnOriginAuthKey",
      "getHarnessEmissionState",
      `${source.slice(expressionStart, expressionEnd)};`,
    ) as (
      input: unknown,
      context: { set(key: symbol, value: unknown): void },
      session: unknown,
      taskDeliveryKey: symbol,
      originAuthKey: symbol,
      readEmission: (state: unknown) => { turnId: string },
    ) => void;
    const taskDeliveryKey = Symbol("task-delivery");
    const originAuthKey = Symbol("origin-auth");
    const context = new Map<symbol, unknown>();
    const contextAdapter = { set: (key: symbol, value: unknown) => context.set(key, value) };
    const firstAuth = { principalId: "user-a" };
    const hitlAuth = { principalId: "approver-b" };
    const taskAuth = { principalId: "user-c" };
    const apply = (input: unknown, turnId: string) => applyDelivery(
      input,
      contextAdapter,
      { state: { turnId } },
      taskDeliveryKey,
      originAuthKey,
      (state) => state as { turnId: string },
    );

    apply({ input: { auth: firstAuth, kind: "deliver", payloads: [] } }, "");
    expect(context.get(originAuthKey)).toBe(firstAuth);

    apply({ input: { auth: hitlAuth, kind: "deliver", payloads: [] } }, "turn_12");
    expect(context.get(originAuthKey)).toBe(firstAuth);

    apply({
      input: {
        auth: taskAuth,
        kind: "deliver",
        payloads: [],
        taskDeliveryId: "task-c:ready:completed",
      },
    }, "");
    expect(context.get(originAuthKey)).toBe(taskAuth);
    expect(context.get(taskDeliveryKey)).toBe(true);

    apply({ input: { kind: "deliver", payloads: [] } }, "");
    expect(context.get(originAuthKey)).toBeNull();
  });

  it("places each task's complete frozen caller on every parent delivery envelope", async () => {
    const source = await readFile(
      "node_modules/eve/dist/src/execution/tasks/child/steps.js",
      "utf8",
    );
    const bodyStart = source.indexOf("const log=");
    if (bodyStart < 0) throw new Error("TEST_EVE_TASK_STEPS_SHAPE_INVALID");
    const instrumentedSource = `
      const delivered=[];
      const createLogger=()=>({warn(){}});
      const resumeSessionInbox=async(...args)=>{delivered.push(args)};
      const getWritable=()=>{throw new Error("TEST_UNEXPECTED_TASK_VIEW_WRITE")};
      const isTaskWorkflowTargetGone=()=>false;
      const TASK_VIEW_STREAM_NAMESPACE="eve.task";
      const isTerminalTaskStatus=(status)=>["completed","failed","cancelled"].includes(status);
      const taskAuthorizationRequestId=(event)=>"task:authorization:"+(event.data.attemptId??event.data.name);
      ${source.slice(bodyStart)}
      export {delivered as __delivered};
    `;
    const runtime = await import(
      `data:text/javascript;base64,${Buffer.from(instrumentedSource).toString("base64")}`
    ) as {
      __delivered: [string, { auth?: unknown }][];
      wakeTaskAuthorizationParentStep(input: unknown): Promise<void>;
      wakeTaskInputRequestParentStep(input: unknown): Promise<void>;
      wakeTaskParentStep(input: unknown): Promise<void>;
      wakeTaskUpdateParentStep(input: unknown): Promise<void>;
    };
    const {
      wakeTaskAuthorizationParentStep,
      wakeTaskInputRequestParentStep,
      wakeTaskParentStep,
      wakeTaskUpdateParentStep,
    } = runtime;
    const firstAuth = {
      attributes: {
        applicationSessionId: "application-session-a",
        familyId: "family-a",
        memoryScopes: ["family"],
        role: "member",
        telegramConversationId: "conversation-a",
        telegramTimelineEntryId: "entry-a",
        telegramTimelineSequence: "41",
        telegramTimelineVisibleEntryIds: ["entry-a"],
        telegramUserId: "telegram-a",
      },
      authenticator: "telegram",
      principalId: "user-a",
      principalType: "user" as const,
    };
    const secondAuth = {
      attributes: {
        applicationSessionId: "application-session-b",
        familyId: "family-b",
        memoryScopes: ["family"],
        role: "member",
        telegramConversationId: "conversation-b",
        telegramTimelineEntryId: "entry-b",
        telegramTimelineSequence: "73",
        telegramTimelineVisibleEntryIds: ["entry-b"],
        telegramUserId: "telegram-b",
      },
      authenticator: "telegram",
      principalId: "user-b",
      principalType: "user" as const,
    };
    await wakeTaskParentStep({
      auth: firstAuth,
      token: "parent-token",
      view: {
        lastOutput: { data: "result", type: "result" },
        metadata: { agentId: "agent-a", kind: "subagent", mode: "local", name: "research" },
        status: "completed",
        taskId: "task-a",
      },
    });
    await wakeTaskUpdateParentStep({
      auth: secondAuth,
      token: "parent-token",
      update: {
        callId: "call-b",
        childStepIndex: 2,
        childTurnId: "child-turn-b",
        kind: "task-update",
        message: "working",
      },
      view: {
        metadata: { agentId: "agent-b", kind: "subagent", mode: "local", name: "research" },
        status: "working",
        taskId: "task-b",
      },
    });
    await wakeTaskAuthorizationParentStep({
      auth: firstAuth,
      request: {
        callId: "call-a",
        childSessionId: "child-session-a",
        event: {
          data: {
            attemptId: "attempt-a",
            description: "Authorize",
            name: "connection-a",
            sequence: 1,
            stepIndex: 3,
            turnId: "child-turn-a",
          },
          type: "authorization.required",
        },
        kind: "authorization-event",
        subagentName: "research",
      },
      taskId: "task-a",
      token: "parent-token",
    });
    await wakeTaskInputRequestParentStep({
      auth: null,
      request: {
        callId: "call-legacy",
        childContinuationToken: "child-token",
        childSessionId: "child-session-legacy",
        event: {
          requests: [{ requestId: "request-legacy" }],
          sequence: 1,
          stepIndex: 4,
          turnId: "child-turn-legacy",
        },
        kind: "subagent-input-request",
        subagentName: "research",
      },
      taskId: "task-legacy",
      token: "parent-token",
    });

    expect(runtime.__delivered.map(([, command]) => command.auth)).toEqual([
      firstAuth,
      secondAuth,
      firstAuth,
      null,
    ]);
  });

  it("keeps every patched task runtime syntactically valid", async () => {
    for (const path of runtimePaths) {
      await expect(execFileAsync(process.execPath, ["--check", path])).resolves.toMatchObject({
        stderr: "",
      });
    }
  });
});
