/**
 * Structured reasoning prompt contract tests.
 *
 * Constructs covered:
 * - `encodeReasoningSelection`: stable string IDs for terminal prompt values.
 * - `decodeReasoningSelection`: strict reconstruction of the structured catalog contract.
 * - `reasoningSelectionLabel`: Russian operator-facing labels for every supported selection.
 */
import { describe, expect, it } from "vitest";

import {
  decodeReasoningSelection,
  encodeReasoningSelection,
  reasoningSelectionLabel,
} from "./reasoning-selection.js";
import type { ReasoningSelection } from "./contracts.js";

const selections: readonly ReasoningSelection[] = [
  { type: "none" },
  { effort: "max", type: "effort" },
  { effort: "xhigh", type: "effort" },
  { effort: "high", type: "effort" },
  { effort: "medium", type: "effort" },
  { effort: "low", type: "effort" },
  { effort: "minimal", type: "effort" },
  { mode: "adaptive", type: "enabled" },
  { mode: "enabled", type: "enabled" },
];

describe("provider installer reasoning selections", () => {
  it("round-trips every structured option through a unique stable string ID", () => {
    const ids = selections.map(encodeReasoningSelection);

    expect(new Set(ids).size).toBe(selections.length);
    expect(ids).toEqual([
      "none",
      "effort:max",
      "effort:xhigh",
      "effort:high",
      "effort:medium",
      "effort:low",
      "effort:minimal",
      "enabled:adaptive",
      "enabled:enabled",
    ]);
    expect(ids.map(decodeReasoningSelection)).toEqual(selections);
  });

  it("provides explicit Russian labels instead of exposing encoded IDs", () => {
    expect(selections.map(reasoningSelectionLabel)).toEqual([
      "Без рассуждений",
      "Максимальное усилие рассуждений",
      "Очень высокое усилие рассуждений",
      "Высокое усилие рассуждений",
      "Среднее усилие рассуждений",
      "Низкое усилие рассуждений",
      "Минимальное усилие рассуждений",
      "Адаптивные рассуждения",
      "Рассуждения включены",
    ]);
  });

  it.each(["", "high", "effort:none", "enabled:max", "enabled:adaptive:extra"])(
    "rejects malformed or unsupported prompt ID %s",
    (id) => {
      expect(() => decodeReasoningSelection(id)).toThrowError(
        /OSINARA_INSTALL_REASONING_SELECTION_INVALID/,
      );
    },
  );
});
