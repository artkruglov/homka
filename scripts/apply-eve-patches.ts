/**
 * Reproducible local Eve 0.40.0 patch installer.
 *
 * Constructs:
 * - `replaceExact`: fail-fast, count-checked, idempotent artifact replacement.
 * - Production startup health wait: permits bounded first-run sandbox preparation.
 * - PostgreSQL connection recovery: a lost LISTEN connection is logged instead of crashing, and a
 *   Graphile worker that died with its connection is unlocked and replaced.
 * - Workflow transport: a 35-minute internal HTTP window and a process-local fence for live redelivery.
 * - Model exact-once policy: disables Eve reissues after observed steps and multi-call compaction
 *   recovery; the empty-response reissue stays because it cannot duplicate a side effect.
 * - Restricted delegation policy: hides only the implicit root agent from external/review modes.
 * - Dynamic skill revision policy: refreshes session packages after a compiled deployment change.
 * - Adapter approval policy: propagates failed `input.requested` persistence.
 * - Background task auth: restores the verified caller that created the task on every parent wake.
 * - Telegram durable ingress: verified-update and authenticated internal-drain hooks.
 * - Telegram dispatch extensions: Session return, message/token override, reply routing, and HITL auth.
 * - Telegram topic normalization: accepts thread IDs only on explicit forum-topic updates.
 * - Telegram public types: exposes only the reviewed application seams.
 * - Provider web search: dynamic provider models select the native backend by provider prefix.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { patchPostgresConnectionRecovery } from "./eve-patches/postgres-connection-recovery.ts";
import { patchStreamRecovery } from "./eve-patches/stream-recovery.ts";
import { patchWorkflowTransport } from "./eve-patches/workflow-transport.ts";

const EXPECTED_EVE_VERSION = "0.40.0";
const EVE_PRODUCTION_START_HEALTH_TIMEOUT_MS = 300_000;

const runtimePaths = {
  channelAdapter: resolve("node_modules/eve/dist/src/channel/adapter.js"),
  channelAdapterTypes: resolve("node_modules/eve/dist/src/channel/adapter.d.ts"),
  compaction: resolve("node_modules/eve/dist/src/harness/compaction.js"),
  contextKeys: resolve("node_modules/eve/dist/src/context/keys.js"),
  contextKeyTypes: resolve("node_modules/eve/dist/src/context/keys.d.ts"),
  dynamicSkillLifecycle: resolve(
    "node_modules/eve/dist/src/context/dynamic-skill-lifecycle.js",
  ),
  dynamicSkillLifecycleTypes: resolve(
    "node_modules/eve/dist/src/context/dynamic-skill-lifecycle.d.ts",
  ),
  dispatchRuntimeActionsShared: resolve(
    "node_modules/eve/dist/src/execution/dispatch-runtime-actions-shared.js",
  ),
  dispatchRuntimeActionsSharedTypes: resolve(
    "node_modules/eve/dist/src/execution/dispatch-runtime-actions-shared.d.ts",
  ),
  providerTools: resolve("node_modules/eve/dist/src/harness/provider-tools.js"),
  productionStart: resolve(
    "node_modules/eve/dist/src/internal/nitro/host/start-production-server.js",
  ),
  telegram: resolve(
    "node_modules/eve/dist/src/public/channels/telegram/telegramChannel.js",
  ),
  telegramInbound: resolve("node_modules/eve/dist/src/public/channels/telegram/inbound.js"),
  telegramIndexTypes: resolve(
    "node_modules/eve/dist/src/public/channels/telegram/index.d.ts",
  ),
  telegramTypes: resolve(
    "node_modules/eve/dist/src/public/channels/telegram/telegramChannel.d.ts",
  ),
  taskChildSteps: resolve(
    "node_modules/eve/dist/src/execution/tasks/child/steps.js",
  ),
  taskChildStepTypes: resolve(
    "node_modules/eve/dist/src/execution/tasks/child/steps.d.ts",
  ),
  taskChildWorkflow: resolve(
    "node_modules/eve/dist/src/execution/tasks/child/workflow.js",
  ),
  taskChildWorkflowTypes: resolve(
    "node_modules/eve/dist/src/execution/tasks/child/workflow.d.ts",
  ),
  taskDispatch: resolve(
    "node_modules/eve/dist/src/execution/tasks/parent/dispatch-task-step.js",
  ),
  taskParentDelegate: resolve(
    "node_modules/eve/dist/src/execution/tasks/parent/delegate.js",
  ),
  taskParentDelegateTypes: resolve(
    "node_modules/eve/dist/src/execution/tasks/parent/delegate.d.ts",
  ),
  toolLoop: resolve("node_modules/eve/dist/src/harness/tool-loop.js"),
  workflowSteps: resolve("node_modules/eve/dist/src/execution/workflow-steps.js"),
} as const;

function occurrenceCount(source: string, marker: string): number {
  if (marker.length === 0) {
    throw new Error("AGENT_EVE_PATCH_MARKER_EMPTY: Eve patch marker cannot be empty");
  }
  return source.split(marker).length - 1;
}

async function replaceExact(
  path: string,
  before: string,
  after: string,
  expectedCount = 1,
): Promise<void> {
  const source = await readFile(path, "utf8");
  const beforeCount = occurrenceCount(source, before);
  const afterCount = occurrenceCount(source, after);
  const embeddedBeforeCount = occurrenceCount(after, before);
  const unpatchedBeforeCount = beforeCount - afterCount * embeddedBeforeCount;

  // A fully patched artifact is accepted unchanged; every partial or unknown state fails closed.
  if (unpatchedBeforeCount === 0 && afterCount === expectedCount) return;
  if (unpatchedBeforeCount !== expectedCount || afterCount !== 0) {
    throw new Error(
      `AGENT_EVE_PATCH_MISMATCH: Не удалось применить проверенный Eve 0.40.0 patch к ${path}; before=${beforeCount}, after=${afterCount}, expected=${expectedCount}`,
    );
  }

  await writeFile(path, source.split(before).join(after), "utf8");
}

// The package version gates every minified replacement against the exact reviewed release.
const evePackage = JSON.parse(
  await readFile(resolve("node_modules/eve/package.json"), "utf8"),
) as { version?: string };
if (evePackage.version !== EXPECTED_EVE_VERSION) {
  throw new Error(
    `AGENT_EVE_PATCH_VERSION_UNSUPPORTED: Ожидалась Eve ${EXPECTED_EVE_VERSION}, установлена ${String(evePackage.version)}`,
  );
}

// Upstream v0.21.3 (6 September 2026): Postgres World loads a whole event stream per read and Eve
// persists a cumulative snapshot per delta, which grew one production session to 155 MB and ended
// in an out-of-memory crash. Reads become paged and demand-driven, delta persistence is paced.
await patchStreamRecovery(replaceExact);
// Upstream nyxandro 2167e2c: a dropped PostgreSQL connection must not crash the process.
await patchPostgresConnectionRecovery(replaceExact);
// Upstream nyxandro 33c935f + 795ae11: a flow request may outlive Node's 300 s header deadline, and
// a redelivery of that live message must join the running execution instead of starting another.
await patchWorkflowTransport(replaceExact);

// A cold production start may prepare sandbox images before the child server becomes healthy.
await replaceExact(
  runtimePaths.productionStart,
  "const HEALTH_TIMEOUT_MS=6e4",
  `const HEALTH_TIMEOUT_MS=${EVE_PRODUCTION_START_HEALTH_TIMEOUT_MS.toExponential().replace("+", "")}`,
);

// Provider transport retries remain AI SDK's responsibility; Eve must never reissue a model call
// that may have produced a side effect. An empty model response (no text, no tool calls) has no
// side effect, so Eve's single nudge-and-reissue for that case is intentionally left in place.
await replaceExact(
  runtimePaths.toolLoop,
  "async function runModelCallWithRetries(e,t,n){for(let r=1;;r++){throwIfTurnAborted(n);try{return await e(r)}catch(e){if(throwIfTurnAborted(n),r===3||classifyModelCallError(e)!==`retry`)throw e;let i=500*2**(r-1)+Math.floor(Math.random()*250);log.warn(`model call failed transiently — retrying`,{attempt:r,delayMs:i,sessionId:t.sessionId,turnId:t.turnId,error:e}),await new Promise(e=>setTimeout(e,i))}}}",
  "async function runModelCallWithRetries(e,t,n){throwIfTurnAborted(n);try{return await e(1)}catch(e){throwIfTurnAborted(n);throw e}}",
);
await replaceExact(
  runtimePaths.toolLoop,
  "async function attemptUnsupportedProviderToolRecovery(e){let t=extractUnsupportedProviderToolTypes(e.error);if(t.length===0)return{outcome:`skipped`};let n=[];for(let e of t){let t=resolveFrameworkToolFromUpstreamType(e);t!==null&&!n.includes(t)&&n.push(t)}if(n.length===0)return{outcome:`skipped`};log.warn(`disabling unsupported provider tool(s); retrying step once`,{disabled:n,sessionId:e.sessionId,turnId:e.turnId,upstreamTypes:t});let r={disabledProviderTools:new Set(n),extraSystemNote:buildDisabledToolNote(n)};try{return{outcome:`recovered`,result:await e.runOneModelCall({...r,suppressStepStartedEmission:!0})}}catch(e){return{outcome:`failed`,error:e,retryCallOptions:r}}}",
  "async function attemptUnsupportedProviderToolRecovery(e){return{outcome:`skipped`}}",
);

// External groups and internal background review must not inherit root delegation. Match the
// complete implicit-agent fingerprint so authored tools and declared subagents remain untouched.
await replaceExact(
  runtimePaths.toolLoop,
  "function buildHarnessToolsWithDynamicSubagents(e,t){let n=new Map(e);if(t===void 0)return n;",
  "function buildHarnessToolsWithDynamicSubagents(e,t){let n=new Map(e);if(t===void 0)return n;let r=t.get(AuthKey),i=n.get(`agent`),a=r?.authenticator===`memory-review`&&r.attributes.memoryReviewMode===`background`||r?.authenticator===`telegram`&&r.attributes.groupType===`external`;a&&i?.runtimeAction?.kind===`subagent-call`&&i.runtimeAction.nodeId===`__root__`&&i.runtimeAction.subagentName===`agent`&&n.delete(`agent`);",
);

// Delivery `context` (memory, timeline, profile card) is authored for one turn, but Eve 0.40.0
// keeps those user messages in the session history, so every later turn carries every earlier
// turn's context: prompts grew by 5–10k tokens per turn and reached 345k in a private chat.
// Each context message is stamped with its turn id, and the prompt of a turn drops stamped
// messages of other turns before the model call; the durable history is rebuilt from that prompt,
// so stale context leaves the session for good while the history prefix stays cache-friendly.
await replaceExact(
  runtimePaths.toolLoop,
  "let H=[...B.messages.slice(0,me),...V,...B.messages.slice(me)],U=await applySessionLimitContinuation(",
  "let H=[...B.messages.slice(0,me),...V,...B.messages.slice(me)].filter(e=>e.role!==`user`||e.providerOptions?.osinara?.turnContext===void 0||e.providerOptions.osinara.turnContext===O.turnId),U=await applySessionLimitContinuation(",
);
await replaceExact(
  runtimePaths.toolLoop,
  "if(I?.context!==void 0&&B.deferredContext!==!0)for(let e of I.context)H.push({content:e,role:`user`});",
  "if(I?.context!==void 0&&B.deferredContext!==!0)for(let e of I.context)H.push({content:e,role:`user`,providerOptions:{osinara:{turnContext:O.turnId}}});",
);

// A resumed approval can execute a tool and request another approval in the same SDK call.
// Its response then begins with the completed previous tool result. Eve otherwise parks that
// result in the new batch, after a user-role pending notice: Anthropic rejects the broken
// call/result adjacency on the next resume (and unrelated messages while parked do too).
// Commit only the leading tool messages now; keep the new assistant call gated in its batch.
// Non-parking paths keep the original response, and no result is invented or executed twice.
await replaceExact(
  runtimePaths.toolLoop,
  "w=[...r,...C===void 0?[]:[{content:C,role:`user`}]],re=getAdvertisedTools",
  "w=(()=>{let e=[...r];if(S.length>0)while(g[0]?.role===`tool`)e.push(g.shift());return[...e,...C===void 0?[]:[{content:C,role:`user`}]]})(),re=getAdvertisedTools",
);

// Compaction may shrink the local recent window, but it may not buy another summary model call.
await replaceExact(
  runtimePaths.compaction,
  "if(evaluateThreshold(v,i,`estimate`).type===`within-limit`||m===0)return v;--m",
  "if(evaluateThreshold(v,i,`estimate`).type===`within-limit`)return v;throw Error(`EVE_COMPACTION_OUTPUT_TOO_LARGE: Compaction result exceeds the configured threshold`)",
);

// Failure to persist an approval prompt must fail the turn instead of parking it unbound.
await replaceExact(
  runtimePaths.channelAdapter,
  "catch(r){log.error(`adapter event handler threw — event swallowed`,{adapterKind:getAdapterKind(e),eventType:n.type,error:r})}return withWaitingContinuationToken(i,r)",
  "catch(r){log.error(`adapter event handler threw`,{adapterKind:getAdapterKind(e),eventType:n.type,error:r});if(n.type===`input.requested`)throw r}return withWaitingContinuationToken(i,r)",
);
await replaceExact(
  runtimePaths.channelAdapterTypes,
  " * Throwing handlers are logged and swallowed so a downstream delivery\n * failure does not corrupt the event stream write path.",
  " * Throwing handlers are logged and swallowed except for `input.requested`, whose\n * failure propagates so an unbound human approval cannot remain parked fail-open.",
);

// Framework task wakes are ordinary deliveries. Without an explicit caller they reuse whichever
// request most recently touched the parent session, which may be an HITL callback or another user.
// Freeze the caller at the originating turn and send it on every durable task-owned wake. The
// optional task-run field keeps old in-flight runs readable; absence becomes null and fails closed.
await replaceExact(
  runtimePaths.contextKeys,
  "ChannelDeliveryKey=new ContextKey(`eve.channelDelivery`),TurnTaskDeliveryKey=new ContextKey(`eve.turnTaskDelivery`)",
  "ChannelDeliveryKey=new ContextKey(`eve.channelDelivery`),TurnOriginAuthKey=new ContextKey(`eve.turnOriginAuth`),TurnTaskDeliveryKey=new ContextKey(`eve.turnTaskDelivery`)",
);
await replaceExact(
  runtimePaths.contextKeys,
  "TurnDynamicToolMetadataKey,TurnTaskDeliveryKey",
  "TurnDynamicToolMetadataKey,TurnOriginAuthKey,TurnTaskDeliveryKey",
);
await replaceExact(
  runtimePaths.contextKeyTypes,
  "export declare const ChannelDeliveryKey: ContextKey<ChannelDeliveryMetadata>;\n/** Whether the active turn began from a task-addressed durable delivery. */",
  "export declare const ChannelDeliveryKey: ContextKey<ChannelDeliveryMetadata>;\n/** Verified caller delivered at the start of the active turn. */\nexport declare const TurnOriginAuthKey: ContextKey<SessionAuthContext | null>;\n/** Whether the active turn began from a task-addressed durable delivery. */",
);
await replaceExact(
  runtimePaths.workflowSteps,
  "SessionDynamicToolRuntimeRevisionKey,TurnTaskDeliveryKey",
  "SessionDynamicToolRuntimeRevisionKey,TurnOriginAuthKey,TurnTaskDeliveryKey",
);
await replaceExact(
  runtimePaths.workflowSteps,
  "a.input?.kind===`deliver`&&c.set(TurnTaskDeliveryKey,a.input.taskDeliveryId!==void 0)",
  "a.input?.kind===`deliver`&&(c.set(TurnTaskDeliveryKey,a.input.taskDeliveryId!==void 0),getHarnessEmissionState(s.state).turnId.length===0&&c.set(TurnOriginAuthKey,a.input.auth??null))",
);
await replaceExact(
  runtimePaths.dispatchRuntimeActionsShared,
  "AuthKey,CapabilitiesKey,ChannelInstrumentationKey,InitiatorAuthKey,SandboxKey",
  "AuthKey,CapabilitiesKey,ChannelInstrumentationKey,InitiatorAuthKey,SandboxKey,TurnOriginAuthKey",
);
await replaceExact(
  runtimePaths.dispatchRuntimeActionsShared,
  "serializedContext:e.serializedContext,session:u}",
  "serializedContext:e.serializedContext,session:u,turnOriginAuth:s.get(TurnOriginAuthKey)}",
);
await replaceExact(
  runtimePaths.dispatchRuntimeActionsSharedTypes,
  "    readonly session: RuntimeSession;\n}",
  "    readonly session: RuntimeSession;\n    readonly turnOriginAuth: Parameters<typeof buildSubagentRunInput>[0][\"auth\"] | undefined;\n}",
);
await replaceExact(
  runtimePaths.taskDispatch,
  "let n=await beginDelegatedTask({",
  "let n=await beginDelegatedTask({auth:i.turnOriginAuth??null,",
);
await replaceExact(
  runtimePaths.taskParentDelegate,
  "initialView:{metadata:o,status:`working`,taskId:r},parentContinuationToken:sessionCommandHookToken(n.session.sessionId)",
  "initialView:{metadata:o,status:`working`,taskId:r},parentAuth:n.auth,parentContinuationToken:sessionCommandHookToken(n.session.sessionId)",
);
await replaceExact(
  runtimePaths.taskParentDelegateTypes,
  "import type { JsonValue } from \"#shared/json.js\";",
  "import type { JsonValue } from \"#shared/json.js\";\nimport type { SessionAuthContext } from \"#channel/types.js\";",
);
await replaceExact(
  runtimePaths.taskParentDelegateTypes,
  "export declare function beginDelegatedTask(input: {\n    readonly agentId: string;",
  "export declare function beginDelegatedTask(input: {\n    readonly auth: SessionAuthContext | null;\n    readonly agentId: string;",
);
await replaceExact(
  runtimePaths.taskChildWorkflowTypes,
  "import { type TaskView } from \"#tasks/types.js\";",
  "import type { SessionAuthContext } from \"#channel/types.js\";\nimport { type TaskView } from \"#tasks/types.js\";",
);
await replaceExact(
  runtimePaths.taskChildWorkflowTypes,
  "    readonly parentContinuationToken: string;\n}",
  "    readonly parentContinuationToken: string;\n    /** Additive for old in-flight task runs; absence is restored as fail-closed null auth. */\n    readonly parentAuth?: SessionAuthContext | null;\n}",
);
await replaceExact(
  runtimePaths.taskChildWorkflow,
  "let a=createHook({token:i.taskInboxToken}),o=a[Symbol.asyncIterator](),s=!1;",
  "let a=createHook({token:i.taskInboxToken}),o=a[Symbol.asyncIterator](),s=!1,y=i.parentAuth??null;",
);
await replaceExact(
  runtimePaths.taskChildWorkflow,
  "wakeTaskUpdateParentStep({token:i.parentContinuationToken,",
  "wakeTaskUpdateParentStep({auth:y,token:i.parentContinuationToken,",
  3,
);
await replaceExact(
  runtimePaths.taskChildWorkflow,
  "wakeTaskParentStep({token:i.parentContinuationToken,",
  "wakeTaskParentStep({auth:y,token:i.parentContinuationToken,",
  2,
);
await replaceExact(
  runtimePaths.taskChildWorkflow,
  "wakeTaskAuthorizationParentStep({request:",
  "wakeTaskAuthorizationParentStep({auth:y,request:",
);
await replaceExact(
  runtimePaths.taskChildWorkflow,
  "wakeTaskInputRequestParentStep({request:",
  "wakeTaskInputRequestParentStep({auth:y,request:",
);
await replaceExact(
  runtimePaths.taskChildSteps,
  "let a={kind:`send`,payload:i,taskDeliveryId:",
  "let a={auth:e.auth,kind:`send`,payload:i,taskDeliveryId:",
);
await replaceExact(
  runtimePaths.taskChildSteps,
  "let r={kind:`send`,payload:n,taskDeliveryId:",
  "let r={auth:e.auth,kind:`send`,payload:n,taskDeliveryId:",
);
await replaceExact(
  runtimePaths.taskChildSteps,
  "let n={kind:`send`,payload:{message:`Background task",
  "let n={auth:e.auth,kind:`send`,payload:{message:`Background task",
);
await replaceExact(
  runtimePaths.taskChildSteps,
  "let n={kind:`send`,payload:{task:{inputRequests:",
  "let n={auth:e.auth,kind:`send`,payload:{task:{inputRequests:",
);
await replaceExact(
  runtimePaths.taskChildStepTypes,
  "export declare function wakeTaskAuthorizationParentStep(input: {\n    readonly request:",
  "export declare function wakeTaskAuthorizationParentStep(input: {\n    readonly auth: import(\"#channel/types.js\").SessionAuthContext | null;\n    readonly request:",
);
await replaceExact(
  runtimePaths.taskChildStepTypes,
  "export declare function wakeTaskParentStep(input: {\n    readonly token:",
  "export declare function wakeTaskParentStep(input: {\n    readonly auth: import(\"#channel/types.js\").SessionAuthContext | null;\n    readonly token:",
);
await replaceExact(
  runtimePaths.taskChildStepTypes,
  "export declare function wakeTaskUpdateParentStep(input: {\n    readonly token:",
  "export declare function wakeTaskUpdateParentStep(input: {\n    readonly auth: import(\"#channel/types.js\").SessionAuthContext | null;\n    readonly token:",
);
await replaceExact(
  runtimePaths.taskChildStepTypes,
  "export declare function wakeTaskInputRequestParentStep(input: {\n    readonly request:",
  "export declare function wakeTaskInputRequestParentStep(input: {\n    readonly auth: import(\"#channel/types.js\").SessionAuthContext | null;\n    readonly request:",
);

// Dynamic tools and subagents already refresh their session-scoped durable selections when the
// compiled runtime changes. Skills must do the same: otherwise a pre-deploy turn-scoped manifest
// survives forever when its resolver moves to session.started, including packages removed by the
// new application. Skill refresh must run inside runStep: the sandbox provider installs SandboxKey
// only after that managed scope starts. Clear every old resolver slot and sandbox package, then
// materialize the current session selection before turn.started applies live external capability.
await replaceExact(
  runtimePaths.contextKeys,
  "SessionDynamicToolRuntimeRevisionKey=new ContextKey(`eve.sessionDynamicToolRuntimeRevision`),TurnDynamicToolMetadataKey",
  "SessionDynamicToolRuntimeRevisionKey=new ContextKey(`eve.sessionDynamicToolRuntimeRevision`),SessionDynamicSkillRuntimeRevisionKey=new ContextKey(`eve.sessionDynamicSkillRuntimeRevision`),TurnDynamicToolMetadataKey",
);
await replaceExact(
  runtimePaths.contextKeys,
  "SessionDynamicToolMetadataKey,SessionDynamicToolRuntimeRevisionKey,SessionIdKey",
  "SessionDynamicSkillRuntimeRevisionKey,SessionDynamicToolMetadataKey,SessionDynamicToolRuntimeRevisionKey,SessionIdKey",
);
await replaceExact(
  runtimePaths.contextKeyTypes,
  "/**\n * Durable session-scoped instruction messages (from `session.started`",
  "/** Compiled runtime revision that produced the current session dynamic skills. */\nexport declare const SessionDynamicSkillRuntimeRevisionKey: ContextKey<string>;\n/**\n * Durable session-scoped instruction messages (from `session.started`",
);
await replaceExact(
  runtimePaths.dynamicSkillLifecycle,
  "import{DynamicSkillManifestKey,SandboxKey}from\"#context/keys.js\"",
  "import{DynamicSkillManifestKey,SandboxKey,SessionDynamicSkillRuntimeRevisionKey}from\"#context/keys.js\"",
);
await replaceExact(
  runtimePaths.dynamicSkillLifecycle,
  "}export{PendingSkillAnnouncementKey,dispatchDynamicSkillEvent};",
  "}async function refreshDynamicSessionSkillsForRuntimeRevision(e){if(e.ctx.get(SessionDynamicSkillRuntimeRevisionKey)===e.runtimeRevision)return;let t=e.ctx.get(DynamicSkillManifestKey)??{};e.ctx.set(DynamicSkillManifestKey,{}),e.ctx.setVirtualContext(PendingSkillAnnouncementKey,await formatDynamicSkillAnnouncement({ctx:e.ctx,manifest:{}}));let n=await e.ctx.require(SandboxKey).get();if(n!==null)for(let r of new Set(Object.values(t).flat().map(e=>e.name)))await removeSkillPackageFromSandbox({name:r,sandbox:n});await dispatchDynamicSkillEvent({ctx:e.ctx,resolvers:e.resolvers,event:e.event,messages:e.messages}),e.ctx.set(SessionDynamicSkillRuntimeRevisionKey,e.runtimeRevision)}export{PendingSkillAnnouncementKey,dispatchDynamicSkillEvent,refreshDynamicSessionSkillsForRuntimeRevision};",
);
await replaceExact(
  runtimePaths.dynamicSkillLifecycleTypes,
  "export declare function dispatchDynamicSkillEvent(input: {",
  "/** Refreshes session skills exactly once for each compiled runtime revision. */\nexport declare function refreshDynamicSessionSkillsForRuntimeRevision(input: {\n    readonly ctx: ContextContainer;\n    readonly resolvers: readonly ResolvedDynamicSkillResolver[];\n    readonly event: UnstampedMessageStreamEvent;\n    readonly messages: readonly ModelMessage[];\n    readonly runtimeRevision: string;\n}): Promise<void>;\nexport declare function dispatchDynamicSkillEvent(input: {",
);
await replaceExact(
  runtimePaths.workflowSteps,
  "SessionDynamicSubagentRuntimeRevisionKey,SessionDynamicToolRuntimeRevisionKey,TurnOriginAuthKey",
  "SessionDynamicSkillRuntimeRevisionKey,SessionDynamicSubagentRuntimeRevisionKey,SessionDynamicToolRuntimeRevisionKey,TurnOriginAuthKey",
);
await replaceExact(
  runtimePaths.workflowSteps,
  "import{dispatchDynamicSkillEvent}from\"#context/dynamic-skill-lifecycle.js\"",
  "import{dispatchDynamicSkillEvent,refreshDynamicSessionSkillsForRuntimeRevision}from\"#context/dynamic-skill-lifecycle.js\"",
);
await replaceExact(
  runtimePaths.workflowSteps,
  "D={...u.graph.root,turnAgent:f.turnAgent},O=buildRuntimeIdentity(D);try{let e=process.env.VERCEL_DEPLOYMENT_ID?.trim()",
  "D={...u.graph.root,turnAgent:f.turnAgent},O=buildRuntimeIdentity(D);let runtimeRevision;try{let e=process.env.VERCEL_DEPLOYMENT_ID?.trim()",
);
await replaceExact(
  runtimePaths.workflowSteps,
  "resolveRuntimeCompiledArtifactsVersionedCacheKey(u.compiledArtifactsSource);if(!v.sessionStarted)c.set(SessionDynamicSubagentRuntimeRevisionKey,t),c.set(SessionDynamicToolRuntimeRevisionKey,t)",
  "resolveRuntimeCompiledArtifactsVersionedCacheKey(u.compiledArtifactsSource);runtimeRevision=t;if(!v.sessionStarted)c.set(SessionDynamicSkillRuntimeRevisionKey,t),c.set(SessionDynamicSubagentRuntimeRevisionKey,t),c.set(SessionDynamicToolRuntimeRevisionKey,t)",
);
await replaceExact(
  runtimePaths.workflowSteps,
  "j=await runStep(c,g,async e=>{let t=resolveEffectiveOutputSchema(",
  "j=await runStep(c,g,async e=>{v.sessionStarted&&await refreshDynamicSessionSkillsForRuntimeRevision({ctx:c,resolvers:C,event:createSessionStartedEvent({runtime:O}),messages:e.history,runtimeRevision});let t=resolveEffectiveOutputSchema(",
);

// A dynamic model selection carries no authored `source`, so Eve fell back to the gateway Exa
// backend even for a direct OpenAI- or Anthropic-protocol provider, and the provider client then
// dropped the unknown tool. Select the native backend from the provider prefix of the model id.
await replaceExact(
  runtimePaths.providerTools,
  "function resolveWebSearchBackend(e,t=`exa`){if(e.source===void 0)return t;let n=e.id.split(`/`)[0]??``;",
  "function resolveWebSearchBackend(e,t=`exa`){let n=e.id.split(`/`)[0]??``;if(e.source===void 0&&!(n===`openai`||n.startsWith(`openai.`)||n===`anthropic`||n.startsWith(`anthropic.`)||n.startsWith(`google.`)))return t;",
);

// Verified webhooks can be durably acknowledged before native dispatch; drain reuses that dispatcher.
await replaceExact(
  runtimePaths.telegram,
  "let u=parseTelegramUpdate(c);return u===null?new Response(`ok`):u.kind===`message`?(o(dispatchMessage({config:e,message:u.message,onMessage:n,uploadPolicy:t,from:a})),new Response(`ok`)):(o(dispatchCallbackQuery({config:e,query:u.callbackQuery,from:a})),new Response(`ok`))",
  "let u=parseTelegramUpdate(c);if(u===null)return new Response(`ok`);let d=l=>l.kind===`message`?dispatchMessage({config:e,message:l.message,onMessage:n,uploadPolicy:t,from:a}):dispatchCallbackQuery({config:e,query:l.callbackQuery,from:a});return e.onVerifiedUpdate!==void 0?e.onVerifiedUpdate({dispatch:d,raw:c,update:u,waitUntil:o}):(o(d(u)),new Response(`ok`))",
);
await replaceExact(
  runtimePaths.telegram,
  "})],async receive",
  "}),...e.onDrain===void 0?[]:[POST(e.drainRoute??`/eve/v1/telegram-drain`,async(r,{from:a,waitUntil:o})=>{if(await verifyInbound(r,e.credentials)===null)return new Response(`unauthorized`,{status:401});let d=l=>l.kind===`message`?dispatchMessage({config:e,message:l.message,onMessage:n,uploadPolicy:t,from:a}):dispatchCallbackQuery({config:e,query:l.callbackQuery,from:a});return e.onDrain({dispatch:d,waitUntil:o})})]],async receive",
);

// Authorized application output controls only the model-visible message and continuation address.
await replaceExact(
  runtimePaths.telegram,
  "catch(e){log.error(`message handler failed`,{error:e});return}if(r==null)return",
  "catch(e){log.error(`message handler failed`,{error:e});throw e}if(r==null)return",
);
await replaceExact(
  runtimePaths.telegram,
  "u=e.message.replyToMessage?.from?.isBot===!0&&l.trim().length>0?",
  "u=r.replyHandling!==`message`&&e.message.replyToMessage?.from?.isBot===!0&&l.trim().length>0?",
);
await replaceExact(
  runtimePaths.telegram,
  "let n=e.from(continuationTokenFromState(t));u===void 0?await n.send(a,{auth:r.auth,context:[o,...s],state:t,title:r.title}):await n.respond(u,{auth:r.auth,context:[o,...s]})",
  "let n=e.from(r.continuationToken??continuationTokenFromState(t));return u===void 0?await n.send(r.message??a,{auth:r.auth,context:[o,...s],state:t,title:r.title}):await n.respond(u,{auth:r.auth,context:[o,...s]})",
);
await replaceExact(
  runtimePaths.telegram,
  "catch(e){log.error(`message delivery failed`,{error:e})}}async function dispatchCallbackQuery",
  "catch(e){log.error(`message delivery failed`,{error:e});throw e}}async function dispatchCallbackQuery",
);

// HITL callbacks are acknowledged only after application authentication selects auth and routing.
// The hook may answer every request of its prompt in one delivery: Eve 0.40.0 merges deferred
// responses only within a single delivery, so answers sent one at a time never resolve a
// multi-request batch and the parked turn waits for an unrelated message.
await replaceExact(
  runtimePaths.telegram,
  "if(e.query.data?.startsWith(TELEGRAM_HITL_CALLBACK_PREFIX)===!0){try{await n.telegram.answerCallbackQuery({callbackQueryId:e.query.id,text:`Answer received.`})}catch(e){log.warn(`Telegram callback-query acknowledgement failed`,{error:e})}if(!e.query.message||!t.chatId)return;try{await e.from(continuationTokenFromState(t)).respond([telegramCallbackInputResponse(e.query.data)],{auth:null})}catch(e){log.error(`callback query delivery failed`,{error:e})}return}",
  "if(e.query.data?.startsWith(TELEGRAM_HITL_CALLBACK_PREFIX)===!0){if(!e.query.message||!t.chatId)return;let r=continuationTokenFromState(t),i=e.config.onHitlCallbackQuery===void 0?{auth:null,continuationToken:e.config.resolveContinuationToken===void 0?r:await e.config.resolveContinuationToken(r)}:await e.config.onHitlCallbackQuery(n,e.query,r);if(i===null)return;try{await n.telegram.answerCallbackQuery({callbackQueryId:e.query.id,text:i.acknowledgementText??`Answer received.`})}catch(e){log.warn(`Telegram callback-query acknowledgement failed`,{error:e})}try{return await e.from(i.continuationToken??r).respond(i.inputResponses??[telegramCallbackInputResponse(e.query.data)],{auth:i.auth})}catch(e){log.error(`callback query delivery failed`,{error:e});throw e}}",
);

// Bot API 10.2 delivers other bots' group messages once Bot-to-Bot Communication Mode is on. Eve
// still drops every bot-authored message before the application sees it, so the agent is blind to
// participants the platform now shows it. Authorization is unaffected: `telegramInboundActor`
// classifies such a sender as `telegram_bot`, which carries no family identity and no rights.
await replaceExact(
  runtimePaths.telegram,
  "async function dispatchMessage(e){if(e.message.from?.isBot===!0)return;",
  "async function dispatchMessage(e){/* bot senders are classified by the application */",
);

// Telegram emits pseudo thread IDs on ordinary replies; only explicit topic messages define scope.
await replaceExact(
  runtimePaths.telegramInbound,
  "messageThreadId:typeof e.message_thread_id==`number`?e.message_thread_id:void 0",
  "messageThreadId:e.is_topic_message===!0&&typeof e.message_thread_id==`number`?e.message_thread_id:void 0",
  2,
);

// Public declarations match runtime hooks without exposing an unverified Request to the application.
await replaceExact(
  runtimePaths.telegramTypes,
  'import { type TelegramCallbackQuery, type TelegramChatType, type TelegramMessage } from "#public/channels/telegram/inbound.js";',
  'import { type TelegramCallbackQuery, type TelegramChatType, type TelegramMessage, type TelegramUpdate } from "#public/channels/telegram/inbound.js";\nimport type { Session } from "#channel/session.js";',
);
const telegramHookDeclarations = `/** Verified Telegram ingress hook context for durable application queues. */
export interface TelegramVerifiedUpdateContext {
    readonly raw: JsonObject;
    readonly update: TelegramUpdate;
    readonly dispatch: (update: TelegramUpdate) => Promise<Session | null | undefined>;
    readonly waitUntil: (task: Promise<unknown>) => void;
}
/** Internal drain hook context using the native verified Telegram dispatcher. */
export interface TelegramDrainContext {
    readonly dispatch: (update: TelegramUpdate) => Promise<Session | null | undefined>;
    readonly waitUntil: (task: Promise<unknown>) => void;
}
/** Application-authenticated result for a Telegram HITL callback. */
export type TelegramHitlCallbackResult = {
    readonly acknowledgementText?: string;
    readonly auth: SessionAuthContext | null;
    readonly continuationToken?: string;
    /** Answers for every request of the claimed prompt; defaults to the tapped callback alone. */
    readonly inputResponses?: readonly { readonly optionId?: string; readonly requestId: string; readonly text?: string; }[];
} | null;
`;
await replaceExact(
  runtimePaths.telegramTypes,
  "/** Configuration for {@link telegramChannel}. */",
  `${telegramHookDeclarations}/** Configuration for {@link telegramChannel}. */`,
);
await replaceExact(
  runtimePaths.telegramTypes,
  "export type TelegramInboundResult = {\n    readonly auth: SessionAuthContext | null;\n    readonly context?: readonly string[];\n    /** Overrides the workflow run title without changing the message sent to the model. */\n    readonly title?: string;\n} | null;",
  "export type TelegramInboundResult = {\n    readonly auth: SessionAuthContext | null;\n    readonly context?: readonly string[];\n    readonly continuationToken?: string;\n    readonly message?: string;\n    readonly replyHandling?: \"message\";\n    /** Overrides the workflow run title without changing the message sent to the model. */\n    readonly title?: string;\n} | null;",
);
const telegramConfigHooks = `    /** Optional internal endpoint that resumes persisted ingress after process restarts. */
    readonly drainRoute?: string;
    /** Drains persisted updates through the native verified dispatcher. */
    readonly onDrain?: (context: TelegramDrainContext) => Response | Promise<Response>;
    /** Resolves a versioned token when no authenticated HITL callback hook is configured. */
    readonly resolveContinuationToken?: (baseToken: string) => string | Promise<string>;
    /** Authenticates the verified Telegram user before a HITL callback resumes Eve. */
    readonly onHitlCallbackQuery?: (ctx: TelegramContext, query: TelegramCallbackQuery, continuationToken: string) => TelegramHitlCallbackResult | Promise<TelegramHitlCallbackResult>;
    /** Runs after webhook verification and parsing, before native dispatch. */
    readonly onVerifiedUpdate?: (context: TelegramVerifiedUpdateContext) => Response | Promise<Response>;
`;
await replaceExact(
  runtimePaths.telegramTypes,
  "    /** Inbound message hook. Defaults to Telegram user auth and dispatch gating. */",
  `${telegramConfigHooks}    /** Inbound message hook. Defaults to Telegram user auth and dispatch gating. */`,
);
await replaceExact(
  runtimePaths.telegramIndexTypes,
  "type TelegramInboundResultOrPromise, type TelegramReceiveTarget, }",
  "type TelegramDrainContext, type TelegramHitlCallbackResult, type TelegramInboundResultOrPromise, type TelegramReceiveTarget, type TelegramVerifiedUpdateContext, }",
);
