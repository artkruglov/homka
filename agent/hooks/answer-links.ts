/**
 * Eve hook: ссылка в ответе должна откуда-то взяться.
 *
 * Export:
 * - Хук, который считает адреса, названные ходом, который ничего не искал и не открывал.
 *
 * Сбои только логируются: учёт ссылок не имеет права уронить ход человека.
 */
import { defineHook } from "eve/hooks";

import { createAnswerLinkAudit } from "../lib/answer-links/answer-links.js";
import { PROVIDER_SEARCH_TOOL_NAMES } from "../lib/provider-search-tool-call.js";

const audit = createAnswerLinkAudit();
const FETCH_TOOL_NAMES: ReadonlySet<string> = new Set(["web_fetch"]);

function key(sessionId: string, turnId: string): string {
  return `${sessionId}:${turnId}`;
}

function report(stage: string, error: unknown): void {
  console.error(JSON.stringify({
    code: "AGENT_ANSWER_LINK_AUDIT_FAILED",
    error: error instanceof Error ? error.message : String(error),
    stage,
  }));
}

function fetchedUrl(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const url = (input as { url?: unknown }).url;
  return typeof url === "string" ? url : null;
}

export default defineHook({
  events: {
    async "message.received"(event, ctx) {
      try {
        const text = (event.data as { message?: { text?: unknown } }).message?.text;
        if (typeof text === "string") audit.received(key(ctx.session.id, ctx.session.turn.id), text);
      } catch (error) {
        report("message.received", error);
      }
    },
    async "actions.requested"(event, ctx) {
      try {
        const actions = (event.data as {
          actions?: readonly { input?: unknown; toolName?: string }[];
          turnId?: string;
        }).actions ?? [];
        const turn = key(ctx.session.id, (event.data as { turnId?: string }).turnId ?? ctx.session.turn.id);
        for (const action of actions) {
          const name = action.toolName ?? "";
          if (PROVIDER_SEARCH_TOOL_NAMES.has(name)) audit.searched(turn);
          if (!FETCH_TOOL_NAMES.has(name)) continue;
          const url = fetchedUrl(action.input);
          if (url === null) audit.searched(turn);
          else audit.fetched(turn, url);
        }
      } catch (error) {
        report("actions.requested", error);
      }
    },
    async "message.completed"(event, ctx) {
      try {
        const data = event.data as { finishReason?: string; message?: string | null };
        if (data.finishReason !== "stop") return;
        const verdict = audit.completed(
          key(ctx.session.id, ctx.session.turn.id), data.message ?? "",
        );
        if (verdict.unsourcedHosts.length === 0) return;
        // Ответ не правится: вырезать адрес значило бы менять сказанное человеку задним числом,
        // а ссылка могла прийти из памяти, куда её сохранил он сам. Случай называется.
        console.warn(JSON.stringify({
          code: "AGENT_ANSWER_LINK_UNSOURCED",
          hosts: verdict.unsourcedHosts.slice(0, 5),
          links: verdict.unsourcedHosts.length,
        }));
      } catch (error) {
        report("message.completed", error);
      }
    },
  },
});
