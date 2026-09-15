/** New cross-context tools are root-owned, private-only where needed, and never scheduled. */
import { describe, expect, it } from "vitest";
import { buildModeToolSurface, buildSubagentToolSurface } from "./tool-policy/mode-tool-surface.js";
import type { ExternalGroupToolName } from "./tool-policy/group-tool-catalog.js";
import { modeInstructions } from "./prompt/mode-instructions.js";
import { FAMILY_PLANNING_RULES } from "./prompt/trusted-fragments.js";
describe('shared task and personal context surfaces',()=>{
  it('requires an explicit external task grant and never grants cross-context search to a group',()=>{
    const none=buildModeToolSurface({environment:'external',capabilities:new Set()});
    const granted=buildModeToolSurface({environment:'external',capabilities:new Set<ExternalGroupToolName>(['manage_shared_tasks'])});
    expect(none.manage_shared_tasks).toBeUndefined();
    expect(granted.manage_shared_tasks).toBeDefined();
    expect(granted.search_my_contexts).toBeUndefined();
    expect(buildModeToolSurface({environment:'family'}).search_my_contexts).toBeUndefined();
    expect(buildModeToolSurface({environment:'private'}).search_my_contexts).toBeDefined();
  });
  it('keeps the trusted planning rules out of the external description',()=>{
    // Описание инструмента уходит в промпт того чата, где инструмент выдан. Раздел про дела,
    // желания и традиции написан для доверенных чатов и во внешней группе читается как правила
    // чужой семьи, то есть переносит режим семьи туда, где его нет.
    const granted=buildModeToolSurface({environment:'external',capabilities:new Set<ExternalGroupToolName>(['manage_shared_tasks'])});
    expect(granted.manage_shared_tasks!.description).not.toContain(FAMILY_PLANNING_RULES);
    expect(modeInstructions({environment:'external',capabilities:new Set()})).not.toContain(FAMILY_PLANNING_RULES);
    for(const environment of ['private','family'] as const) {
      expect(modeInstructions({environment})).toContain(FAMILY_PLANNING_RULES);
    }
  });
  it('hides both tools in child and scheduled turns',()=>{
    for(const environment of ['private','family'] as const) {
      for(const surface of [buildSubagentToolSurface({environment}),buildModeToolSurface({environment,scheduledRun:true})]) {
        expect(surface.manage_shared_tasks).toBeUndefined();
        expect(surface.search_my_contexts).toBeUndefined();
      }
    }
    expect(buildModeToolSurface({environment:'external',scheduledRun:true,
      capabilities:new Set<ExternalGroupToolName>(['manage_shared_tasks'])}).manage_shared_tasks).toBeUndefined();
  });
});
