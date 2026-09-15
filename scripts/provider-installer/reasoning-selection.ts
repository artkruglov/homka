/**
 * Structured reasoning selection prompt boundary.
 *
 * Exports:
 * - `encodeReasoningSelection`: canonical stable ID for string-only prompt values.
 * - `decodeReasoningSelection`: strict ID parser for the standalone structured contract.
 * - `reasoningSelectionLabel`: Russian label for operator-facing choices.
 * - `isReasoningSelection`: runtime validation for injected catalog metadata.
 */
import type { ReasoningEffort, ReasoningSelection } from "./contracts.ts";
import { InstallerError } from "./errors.ts";

const REASONING_EFFORTS = new Set<ReasoningEffort>([
  "max",
  "xhigh",
  "high",
  "medium",
  "low",
  "minimal",
]);

const REASONING_LABELS: Readonly<Record<string, string>> = {
  "effort:high": "Высокое усилие рассуждений",
  "effort:low": "Низкое усилие рассуждений",
  "effort:max": "Максимальное усилие рассуждений",
  "effort:medium": "Среднее усилие рассуждений",
  "effort:minimal": "Минимальное усилие рассуждений",
  "effort:xhigh": "Очень высокое усилие рассуждений",
  "enabled:adaptive": "Адаптивные рассуждения",
  "enabled:enabled": "Рассуждения включены",
  none: "Без рассуждений",
};

export function isReasoningSelection(value: unknown): value is ReasoningSelection {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  const selection = value as Record<string, unknown>;
  if (selection.type === "none") {
    return Object.keys(selection).length === 1;
  }
  if (selection.type === "effort") {
    return (
      Object.keys(selection).length === 2 &&
      typeof selection.effort === "string" &&
      REASONING_EFFORTS.has(selection.effort as ReasoningEffort)
    );
  }
  return (
    selection.type === "enabled" &&
    Object.keys(selection).length === 2 &&
    (selection.mode === "adaptive" || selection.mode === "enabled")
  );
}

export function encodeReasoningSelection(selection: ReasoningSelection): string {
  if (!isReasoningSelection(selection)) {
    throw new InstallerError(
      "OSINARA_INSTALL_REASONING_SELECTION_INVALID",
      "Каталог содержит некорректный вариант рассуждений",
    );
  }
  if (selection.type === "none") return "none";
  if (selection.type === "effort") return `effort:${selection.effort}`;
  return `enabled:${selection.mode}`;
}

export function decodeReasoningSelection(id: string): ReasoningSelection {
  if (id === "none") return { type: "none" };
  const [type, value, extra] = id.split(":");
  if (extra === undefined && type === "effort" && REASONING_EFFORTS.has(value as ReasoningEffort)) {
    return { effort: value as ReasoningEffort, type: "effort" };
  }
  if (extra === undefined && type === "enabled" && (value === "adaptive" || value === "enabled")) {
    return { mode: value, type: "enabled" };
  }
  throw new InstallerError(
    "OSINARA_INSTALL_REASONING_SELECTION_INVALID",
    "Выбран неизвестный вариант рассуждений",
  );
}

export function reasoningSelectionLabel(selection: ReasoningSelection): string {
  return REASONING_LABELS[encodeReasoningSelection(selection)] as string;
}
