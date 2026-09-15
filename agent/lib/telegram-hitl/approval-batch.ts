/**
 * One Telegram prompt for every approval request of a single Eve step.
 *
 * Exports:
 * - `isBatchedApprovalStep`: a step whose requests are all button-answered tool approvals.
 * - `combineApprovalRequests`: the single request rendered in place of the whole step.
 *
 * Key constructs:
 * - Eve 0.40.0 resolves a multi-request batch only from one delivery; answers that arrive one at
 *   a time are dropped from the deferred input, and the parked turn waits for an unrelated
 *   message. One prompt with one tap answers every request in one delivery.
 * - The combined request keeps the first request's id and callback semantics; the claim expands
 *   the tapped option to every member request.
 */
import type { InputRequestKind } from "eve/client";

import type { TelegramInputRequest } from "../telegram-interface.js";

export interface PresentedInputRequest {
  kind: InputRequestKind;
  request: TelegramInputRequest;
}

const BATCH_OPTION_LABELS: Readonly<Record<string, string>> = {
  approve: "Да, подтвердить все",
  cancel: "Нет, отменить все",
};

function pluralActions(count: number): string {
  const tail = count % 10;
  const teens = count % 100 >= 11 && count % 100 <= 14;
  if (tail === 1 && !teens) return "действие";
  if (tail >= 2 && tail <= 4 && !teens) return "действия";
  return "действий";
}

export function isBatchedApprovalStep(requests: readonly PresentedInputRequest[]): boolean {
  if (requests.length < 2) return false;
  return requests.every(({ kind, request }) =>
    kind === "tool-approval" &&
    (request.options?.length ?? 0) > 0 &&
    request.options!.every((option) => option.id in BATCH_OPTION_LABELS)
  );
}

export function combineApprovalRequests(
  requests: readonly PresentedInputRequest[],
): TelegramInputRequest {
  const first = requests[0];
  if (!first || !isBatchedApprovalStep(requests)) {
    throw new Error("AGENT_APPROVAL_BATCH_INVALID: Шаг не состоит из подтверждений с кнопками");
  }
  const prompt = [
    `Нужно подтвердить сразу ${requests.length} ${pluralActions(requests.length)}. Кнопка внизу отвечает за все.`,
    ...requests.map(({ request }, index) => `${index + 1}. ${request.prompt}`),
  ].join("\n\n");
  return {
    ...first.request,
    options: first.request.options!.map((option) => ({
      ...option,
      label: BATCH_OPTION_LABELS[option.id] ?? option.label,
    })),
    prompt,
  };
}
