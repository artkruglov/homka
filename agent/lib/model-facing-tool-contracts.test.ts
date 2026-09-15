/**
 * Complete model-facing tool surface contract test.
 *
 * Constructs covered:
 * - Private, family, external, scheduled-external, subagent, and memory-review surfaces.
 * - Every emitted tool explains selection, input, output, and structured error recovery.
 * - External path overrides retain the narrower group-relative contract.
 */
import { describe, expect, it } from "vitest";

import { buildMemoryReviewToolSurface } from "./memory-review/memory-review-tool-surface.js";
import { EXTERNAL_GROUP_TOOL_NAMES } from "./tool-policy/group-tool-catalog.js";
import {
  buildModeToolSurface,
  buildSubagentToolSurface,
} from "./tool-policy/mode-tool-surface.js";

// Generic call discipline (when to call, input provenance, result and error handling) is stated
// once in the permanent instructions. Repeating it per descriptor cost ~17k characters per step.
const GENERIC_DESCRIPTION_FILLER = [
  "Когда использовать: только когда назначение выше",
  "Вход: передавай только поля schema",
  "Ошибка: следуй code, correction, retryable",
] as const;
const TOTAL_DESCRIPTION_MAX_CHARACTERS = 30_000;
const TOOL_DESCRIPTION_MAX_CHARACTERS = 3_000;
const DENIED_DESCRIPTION_MAX_CHARACTERS = 160;

function surfaces() {
  const externalInput = {
    capabilities: new Set(EXTERNAL_GROUP_TOOL_NAMES),
    environment: "external" as const,
    includeApplicationCore: true,
    scheduledHistory: false,
  };
  return {
    external: buildModeToolSurface(externalInput),
    family: buildModeToolSurface({ environment: "family" }),
    memoryReview: buildMemoryReviewToolSurface(),
    private: buildModeToolSurface({ environment: "private" }),
    scheduledExternal: buildModeToolSurface({
      ...externalInput,
      scheduledHistory: true,
      scheduledRun: true,
    }),
    subagent: buildSubagentToolSurface(externalInput),
  };
}

describe("model-facing tool contracts", () => {
  it("walks every emitted mode surface and requires a complete compact descriptor", () => {
    for (const [surfaceName, surface] of Object.entries(surfaces())) {
      expect(Object.keys(surface).length, `${surfaceName} must emit tools`).toBeGreaterThan(0);
      const totalDescriptionCharacters = Object.values(surface)
        .reduce((total, definition) => total + definition.description.length, 0);
      expect(totalDescriptionCharacters, `${surfaceName} total prompt size`)
        .toBeLessThanOrEqual(TOTAL_DESCRIPTION_MAX_CHARACTERS);
      for (const [toolName, definition] of Object.entries(surface)) {
        expect(definition.inputSchema, `${surfaceName}.${toolName} input schema`).toBeDefined();
        expect(typeof definition.execute, `${surfaceName}.${toolName} executor`).toBe("function");
        const denied = /недоступен/u.test(definition.description);
        expect(definition.description.length, `${surfaceName}.${toolName} prompt size`)
          .toBeLessThan(denied ? DENIED_DESCRIPTION_MAX_CHARACTERS : TOOL_DESCRIPTION_MAX_CHARACTERS);
        for (const filler of GENERIC_DESCRIPTION_FILLER) {
          expect(definition.description, `${surfaceName}.${toolName} repeats generic filler`)
            .not.toContain(filler);
        }
      }
    }
  });

  it("keeps external image and delivery paths relative while native file paths stay absolute", () => {
    const external = surfaces().external;

    expect(external.send_workspace_file!.description).toContain("reports/result.pdf");
    expect(external.send_workspace_file!.description).toContain("не передавай /workspace/group");
    expect(external.inspect_workspace_image!.description).toContain("photos/image.png");
    expect(external.read_file!.description).toContain("/workspace/group");
  });
});
