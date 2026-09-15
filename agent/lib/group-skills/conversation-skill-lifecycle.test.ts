/**
 * Dynamic skill lifecycle regression tests.
 *
 * Stable trusted packages are session-scoped so Eve does not upload every
 * Google Workspace skill again before each model turn. External capability
 * changes remain turn-scoped.
 */
import { describe, expect, it } from "vitest";

import externalSkills from "../../skills/external.js";
import scopedSkills from "../../skills/scoped.js";

describe("conversation skill lifecycle", () => {
  it("materializes stable trusted skills at session scope only", () => {
    expect(scopedSkills.events["session.started"]).toBeTypeOf("function");
    expect(scopedSkills.events["turn.started"]).toBeUndefined();
  });

  it("refreshes capability-coupled external skills at turn scope only", () => {
    expect(externalSkills.events["turn.started"]).toBeTypeOf("function");
    expect(externalSkills.events["session.started"]).toBeUndefined();
  });
});
