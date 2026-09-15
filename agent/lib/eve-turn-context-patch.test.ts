/**
 * Eve turn-context patch tests.
 *
 * Delivery `context` is authored for one turn. Eve 0.40.0 kept those user messages in the
 * session history, so every later turn carried every earlier turn's memory and timeline blocks.
 * The patch stamps each context message with its turn id and drops other turns' stamped messages
 * from the prompt before the model call.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Eve turn context patch", () => {
  it("stamps delivery context with the turn id and filters other turns' context from the prompt", async () => {
    const [patch, toolLoop] = await Promise.all([
      readFile("scripts/apply-eve-patches.ts", "utf8"),
      readFile("node_modules/eve/dist/src/harness/tool-loop.js", "utf8"),
    ]);

    expect(patch).toContain("osinara:{turnContext:O.turnId}");
    const stamp = toolLoop.indexOf(
      "for(let e of I.context)H.push({content:e,role:`user`,providerOptions:{osinara:{turnContext:O.turnId}}})",
    );
    const filter = toolLoop.indexOf(
      ".filter(e=>e.role!==`user`||e.providerOptions?.osinara?.turnContext===void 0||e.providerOptions.osinara.turnContext===O.turnId)",
    );
    // The prompt is filtered before this turn's context is appended, so the current turn keeps
    // its own blocks on every model step while earlier turns' blocks never reach the model again.
    expect(filter).toBeGreaterThanOrEqual(0);
    expect(stamp).toBeGreaterThan(filter);
    expect(toolLoop).not.toContain("for(let e of I.context)H.push({content:e,role:`user`});");
  });
});
