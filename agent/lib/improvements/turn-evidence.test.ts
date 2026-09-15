/**
 * Turn evidence tests.
 *
 * Constructs covered:
 * - Tool names, loaded skills and step count accumulate per session and turn; failed results
 *   attach to the tool.
 * - The trigger fires on a failed tool, a failed turn, or a heavy turn, never on a quiet one.
 * - The fingerprint is stable for the same tool and code and ignores summary wording then.
 */
import { describe, expect, it } from "vitest";

import {
  createTurnEvidenceCollector,
  improvementFingerprint,
  shouldReflectOnTurn,
} from "./turn-evidence.js";

describe("turn evidence collector", () => {
  it("collects tool calls, failures by call id, and the turn failure", () => {
    const collector = createTurnEvidenceCollector();
    collector.actionsRequested({
      actions: [{ callId: "c1", kind: "tool-call", toolName: "generate_image" }, { input: { skill: "birthday-card" }, kind: "load-skill" }],
      sessionId: "s", turnId: "t",
    });
    collector.actionsRequested({ actions: [{ callId: "c2", kind: "tool-call", toolName: "remember" }], sessionId: "s", turnId: "t" });
    collector.actionResult({ callId: "c1", error: { code: "AGENT_IMAGE_PROVIDER_FAILED", message: "  провайдер  упал " }, sessionId: "s", status: "failed", turnId: "t" });
    collector.actionResult({ callId: "c2", sessionId: "s", status: "completed", turnId: "t" });
    collector.turnFailed({ code: "MODEL_CALL_FAILED", message: "x", sessionId: "s", turnId: "t" });

    expect(collector.take("s", "t")).toEqual({
      failedTools: [{ code: "AGENT_IMAGE_PROVIDER_FAILED", message: "провайдер упал", toolName: "generate_image" }],
      loadedSkills: ["birthday-card"],
      stepCount: 2,
      toolNames: ["generate_image", "remember"],
      turnFailure: { code: "MODEL_CALL_FAILED", message: "x" },
    });
    expect(collector.take("s", "t")).toBeNull();
  });

  it("triggers on a failure or a heavy turn only", () => {
    const quiet = { failedTools: [], loadedSkills: [], stepCount: 3, toolNames: ["remember"], turnFailure: null };
    expect(shouldReflectOnTurn(quiet)).toBe(false);
    expect(shouldReflectOnTurn({ ...quiet, failedTools: [{ code: "X", message: "", toolName: "bash" }] })).toBe(true);
    expect(shouldReflectOnTurn({ ...quiet, turnFailure: { code: "X", message: "" } })).toBe(true);
    expect(shouldReflectOnTurn({ ...quiet, stepCount: 8 })).toBe(true);
  });

  it("fingerprints by tool and code when known, else by the summary head", () => {
    const a = improvementFingerprint({ category: "tool_error", errorCode: "E1", summary: "Первая формулировка", toolName: "bash" });
    const b = improvementFingerprint({ category: "tool_error", errorCode: "E1", summary: "Совсем другая формулировка", toolName: "bash" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/u);
    const c = improvementFingerprint({ category: "workflow", summary: "Слишком много шагов при поиске!" });
    const d = improvementFingerprint({ category: "workflow", summary: "слишком   много шагов при поиске" });
    expect(c).toBe(d);
    expect(c).not.toBe(a);
  });
});
