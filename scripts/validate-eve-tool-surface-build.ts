/**
 * Post-build Eve dynamic tool surface validation.
 *
 * Exports:
 * - `validateCompiledDynamicToolSurface`: verifies the generated capabilities resolver contract.
 *
 * CLI behavior:
 * - Reads `.output/server/index.mjs` after `eve build` and fails before release on contract drift.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const CAPABILITIES_REGION = "#region agent/tools/capabilities.ts";
const REGION_END = "//#endregion";
const DYNAMIC_EVENTS_PATTERN = /defineDynamic(?:\$\d+)?\s*\(\s*\{\s*events\s*:\s*\{\s*"([^"]+)"\s*:/gu;
const REPLAY_PRONE_EVENT_KEY_PATTERN = /"(?:session|turn)\.started"\s*:/u;

function buildContractError(reason: string): Error {
  return new Error(
    `AGENT_EVE_DYNAMIC_TOOL_BUILD_INVALID: Скомпилированный tool resolver нарушает ` +
      `step-scoped контракт Eve: ${reason}`,
  );
}

export function validateCompiledDynamicToolSurface(compiledServer: string): void {
  const regionStart = compiledServer.indexOf(CAPABILITIES_REGION);
  if (regionStart < 0) throw buildContractError("не найден capabilities region");
  const regionEnd = compiledServer.indexOf(REGION_END, regionStart);
  if (regionEnd < 0) throw buildContractError("capabilities region не завершён");
  const region = compiledServer.slice(regionStart, regionEnd);

  // Helper-created definitions are intentionally rebuilt at every step. A turn-scoped resolver
  // would require AST-generated replay metadata that helper modules cannot provide.
  const dynamicEvents = [...region.matchAll(DYNAMIC_EVENTS_PATTERN)];
  if (dynamicEvents.length !== 1 || dynamicEvents[0]?.[1] !== "step.started") {
    throw buildContractError("отсутствует step.started resolver");
  }
  if (REPLAY_PRONE_EVENT_KEY_PATTERN.test(region)) {
    throw buildContractError("обнаружен replay-prone session/turn resolver");
  }
}

async function main(): Promise<void> {
  const compiledServer = await readFile(".output/server/index.mjs", "utf8");
  validateCompiledDynamicToolSurface(compiledServer);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
