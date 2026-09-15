/**
 * Eve provider web-search backend patch tests.
 *
 * Constructs covered:
 * - A dynamic provider model (no authored source) selects the native web_search backend by the
 *   provider prefix of its resolved id instead of the gateway Exa default.
 * - The patched runtime stays syntactically valid.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const PROVIDER_TOOLS_PATH = "node_modules/eve/dist/src/harness/provider-tools.js";

describe("eve provider web-search backend patch", () => {
  it("selects the native backend from the model id when the reference has no source", async () => {
    const runtime = await readFile(PROVIDER_TOOLS_PATH, "utf8");

    expect(runtime).toContain(
      "function resolveWebSearchBackend(e,t=`exa`){let n=e.id.split(`/`)[0]??``;if(e.source===void 0&&!(n===`openai`",
    );
    expect(runtime).not.toContain("function resolveWebSearchBackend(e,t=`exa`){if(e.source===void 0)return t;");
  });

  it("keeps the patched provider-tools runtime syntactically valid", async () => {
    await expect(execFileAsync(process.execPath, ["--check", PROVIDER_TOOLS_PATH])).resolves.toMatchObject({
      stderr: "",
    });
  });
});
