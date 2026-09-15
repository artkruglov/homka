/**
 * Durable Telegram HITL approval persistence.
 *
 * Exports:
 * - `TelegramHitlApprovalRepository`: injectable registration and authorization contract.
 * - `telegramHitlApprovalRepository`: PostgreSQL implementation with atomic callback claims.
 * - Approval input/result types used by Telegram channel boundaries.
 */
import type { SessionAuthContext } from "eve/context";
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import {
  resolveCurrentApprovalAuth,
} from "./approval-auth.js";

import { lockApprovals, isPendingApproval, type ApprovalRow } from "./approval-session.js";

type TelegramChatType = "group" | "private" | "supergroup";

export interface RegisterTelegramHitlApprovalInput {
  applicationSessionId: string;
  /** Framework-owned request source; the confirmation window applies only to human-answerable kinds. */
  kind: "question" | "session-limit" | "tool-approval";
  callbackData: readonly string[];
  callbackOptions: readonly {
    callbackData: string;
    label: string;
    optionId: string;
  }[];
  eveSessionId: string;
  requestId: string;
  promptText: string;
  telegramChatId: string;
  telegramChatType: TelegramChatType;
  /** Conversation and timeline entry of the turn, restored into the resumed auth after approval. */
  telegramConversationId?: string;
  telegramMessageId: string;
  telegramMessageThreadId: string | null;
  telegramTimelineEntryId?: string;
  telegramUserId: string;
  toolCallId: string;
  toolInputHash: string;
  toolName: string;
}

export interface ClaimTelegramHitlCallbackInput {
  baseContinuationToken: string;
  callbackData: string;
  telegramChatId: string;
  telegramMessageId: string;
  telegramUserId: string;
}

export interface AuthorizeTelegramHitlReplyInput {
  baseContinuationToken: string;
  telegramChatId: string;
  telegramMessageId: string;
  telegramUserId: string;
}

export type TelegramHitlCallbackClaim =
  | {
      auth: SessionAuthContext;
      continuationToken: string;
      promptText: string;
      /** Every request rendered by the claimed prompt; one delivery answers all of them. */
      requestIds: readonly string[];
      selectedOptionId: string;
      selectedOptionLabel: string;
      status: "authorized";
    }
  | { status: "expired" | "forbidden" };
export type TelegramHitlReplyAuthorization =
  "authorized" | "expired" | "forbidden" | "not_applicable";

export interface TelegramHitlApprovalRepository {
  authorizeReply(input: AuthorizeTelegramHitlReplyInput): Promise<TelegramHitlReplyAuthorization>;
  claimCallback(input: ClaimTelegramHitlCallbackInput): Promise<TelegramHitlCallbackClaim>;
  clearForEveSession(applicationSessionId: string, eveSessionId: string): Promise<void>;
  hasPendingForSession(applicationSessionId: string, eveSessionId: string): Promise<boolean>;
  requireToolExecutionApproval(input: {
    applicationSessionId: string;
    eveSessionId: string;
    telegramUserId: string;
    toolCallId: string;
    toolInputHash: string;
    toolName: string;
  }): Promise<void>;
  register(input: RegisterTelegramHitlApprovalInput): Promise<void>;
}

function selectedCallbackOption(
  row: ApprovalRow,
  callbackData: string,
): { label: string; optionId: string } | null {
  if (!Array.isArray(row.callback_options)) return null;
  for (const option of row.callback_options) {
    if (!option || typeof option !== "object" || Array.isArray(option)) continue;
    const value = option as Record<string, unknown>;
    if (
      value.callbackData === callbackData &&
      typeof value.label === "string" && value.label &&
      typeof value.optionId === "string" && value.optionId
    ) return { label: value.label, optionId: value.optionId };
  }
  return null;
}

async function routeBelongsToSession(
  client: PoolClient,
  baseContinuationToken: string,
  applicationSessionId: string,
): Promise<boolean> {
  const result = await client.query<{ matches: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM conversation_session_routes
        WHERE base_continuation_token = $1
          AND session_id = $2
     ) AS matches`,
    [baseContinuationToken, applicationSessionId],
  );
  return result.rows[0]?.matches === true;
}

async function routeHasPendingOperation(
  client: PoolClient,
  baseContinuationToken: string,
): Promise<boolean> {
  const result = await client.query<{ pending: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM conversation_session_routes r
         JOIN conversation_sessions s ON s.id = r.session_id
        WHERE r.base_continuation_token = $1
          AND s.pending_operation = true
          AND s.retired_at IS NULL
     ) AS pending`,
    [baseContinuationToken],
  );
  return result.rows[0]?.pending === true;
}

export const telegramHitlApprovalRepository: TelegramHitlApprovalRepository = {
  async register(input) {
    await database().query(
      `INSERT INTO telegram_hitl_approvals
         (application_session_id, eve_session_id, request_id,
           telegram_chat_id, telegram_chat_type, telegram_message_id,
           telegram_message_thread_id, expected_telegram_user_id, callback_data,
            prompt_text, callback_options, tool_call_id, tool_name, tool_input_hash,
            request_kind, telegram_conversation_id, telegram_timeline_entry_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       ON CONFLICT (application_session_id, eve_session_id, request_id) DO UPDATE
         SET telegram_chat_id = EXCLUDED.telegram_chat_id,
             telegram_conversation_id = EXCLUDED.telegram_conversation_id,
             telegram_timeline_entry_id = EXCLUDED.telegram_timeline_entry_id,
             telegram_chat_type = EXCLUDED.telegram_chat_type,
             telegram_message_id = EXCLUDED.telegram_message_id,
             telegram_message_thread_id = EXCLUDED.telegram_message_thread_id,
              expected_telegram_user_id = EXCLUDED.expected_telegram_user_id,
              callback_data = EXCLUDED.callback_data,
              prompt_text = EXCLUDED.prompt_text,
               callback_options = EXCLUDED.callback_options,
               tool_call_id = EXCLUDED.tool_call_id,
               tool_name = EXCLUDED.tool_name,
               tool_input_hash = EXCLUDED.tool_input_hash,
               request_kind = EXCLUDED.request_kind,
              -- A replayed request re-opens the prompt, so no timeout state may survive it.
              timed_out_at = NULL,
              timeout_lease_token = NULL,
              timeout_lease_expires_at = NULL,
              timeout_attempts = 0,
              selected_option_id = NULL,
              selected_option_label = NULL,
              consumed_at = NULL`,
      [
        input.applicationSessionId,
        input.eveSessionId,
        input.requestId,
        input.telegramChatId,
        input.telegramChatType,
        input.telegramMessageId,
        input.telegramMessageThreadId,
        input.telegramUserId,
        input.callbackData,
        input.promptText,
        JSON.stringify(input.callbackOptions),
        input.toolCallId,
        input.toolName,
        input.toolInputHash,
        input.kind,
        input.telegramConversationId ?? null,
        input.telegramTimelineEntryId ?? null,
      ],
    );
  },

  async requireToolExecutionApproval(input) {
    const result = await database().query<{ authorized: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM telegram_hitl_approvals AS approval
         JOIN conversation_sessions AS session ON session.id = approval.application_session_id
         WHERE approval.application_session_id = $1
           AND approval.eve_session_id = $2
           AND approval.expected_telegram_user_id = $3
           AND approval.tool_call_id = $4
           AND approval.tool_name = $5
           AND approval.tool_input_hash = $6
           AND approval.consumed_at IS NOT NULL
           AND approval.timed_out_at IS NULL
           AND (approval.selected_option_id IS NULL OR approval.selected_option_id = 'approve')
           AND session.eve_session_id = approval.eve_session_id
           AND session.retired_at IS NULL
           AND (session.space_policy_version IS NULL OR EXISTS (
             SELECT 1 FROM spaces audience
              WHERE audience.id=session.space_id AND audience.family_id=session.family_id
                AND audience.state='active' AND audience.policy_version=session.space_policy_version
           ))
       ) AS authorized`,
      [input.applicationSessionId, input.eveSessionId, input.telegramUserId,
        input.toolCallId, input.toolName, input.toolInputHash],
    );
    if (result.rows[0]?.authorized !== true) {
      throw new AppError(
        "AGENT_TOOL_APPROVAL_EVIDENCE_INVALID",
        "Не удалось подтвердить решение пользователя для этого действия. Запросите подтверждение заново",
      );
    }
  },

  async claimCallback(input) {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const rows = await lockApprovals(client, input.telegramChatId, input.telegramMessageId);
      const row = rows[0];
      const selectedOption = row ? selectedCallbackOption(row, input.callbackData) : null;
      // Every row of the prompt must still be answerable: a partially consumed prompt is stale.
      if (
        !row ||
        !selectedOption ||
        rows.some((candidate) =>
          !isPendingApproval(candidate) || !candidate.space_policy_current ||
          !candidate.callback_data.includes(input.callbackData) ||
          !candidate.prompt_text
        )
      ) {
        await client.query("ROLLBACK");
        return { status: "expired" };
      }
      if (rows.some((candidate) => candidate.expected_telegram_user_id !== input.telegramUserId)) {
        await client.query("ROLLBACK");
        return { status: "forbidden" };
      }
      if (!await routeBelongsToSession(
        client,
        input.baseContinuationToken,
        row.application_session_id,
      )) {
        await client.query("ROLLBACK");
        return { status: "expired" };
      }
      const auth = await resolveCurrentApprovalAuth(client, row);
      if (!auth) {
        await client.query("ROLLBACK");
        return { status: "forbidden" };
      }
      const consumed = await client.query(
        `UPDATE telegram_hitl_approvals
            SET consumed_at = now(), selected_option_id = $2, selected_option_label = $3
          WHERE id = ANY($1::uuid[]) AND consumed_at IS NULL`,
        [rows.map((candidate) => candidate.id), selectedOption.optionId, selectedOption.label],
      );
      if (consumed.rowCount !== rows.length) {
        await client.query("ROLLBACK");
        return { status: "expired" };
      }
      await client.query(
        `UPDATE conversation_sessions session
            SET pending_operation = EXISTS (
                  SELECT 1 FROM telegram_hitl_approvals pending
                   WHERE pending.application_session_id = session.id
                     AND pending.eve_session_id = $2
                     AND pending.consumed_at IS NULL
                ),
                pending_request_id = CASE
                  WHEN EXISTS (
                    SELECT 1 FROM telegram_hitl_approvals pending
                     WHERE pending.application_session_id = session.id
                       AND pending.eve_session_id = $2
                       AND pending.consumed_at IS NULL
                  ) THEN pending_request_id
                  ELSE NULL
                END,
                task_state = CASE
                  WHEN kind = 'task' AND NOT EXISTS (
                    SELECT 1 FROM telegram_hitl_approvals pending
                     WHERE pending.application_session_id = session.id
                       AND pending.eve_session_id = $2
                       AND pending.consumed_at IS NULL
                  ) THEN 'running'::conversation_task_state
                  ELSE task_state
                END
          WHERE session.id = $1`,
        [row.application_session_id, row.eve_session_id],
      );
      await client.query("COMMIT");
      return {
        auth,
        continuationToken: row.continuation_token,
        promptText: row.prompt_text!,
        requestIds: rows.map((candidate) => candidate.request_id),
        selectedOptionId: selectedOption.optionId,
        selectedOptionLabel: selectedOption.label,
        status: "authorized",
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async authorizeReply(input) {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const row = (await lockApprovals(client, input.telegramChatId, input.telegramMessageId))[0];
      if (!row) {
        const pending = await routeHasPendingOperation(client, input.baseContinuationToken);
        await client.query("ROLLBACK");
        return pending ? "expired" : "not_applicable";
      }
      const routeMatches = await routeBelongsToSession(
        client,
        input.baseContinuationToken,
        row.application_session_id,
      );
      if (!isPendingApproval(row)) {
        // A consumed or retired prompt is ordinary historical ancestry. Remove any stale alias in
        // the same transaction so it cannot select old task model state during canonical prepare.
        await client.query(
          "DELETE FROM conversation_session_routes WHERE base_continuation_token = $1 AND session_id = $2",
          [input.baseContinuationToken, row.application_session_id],
        );
        await client.query("COMMIT");
        return "not_applicable";
      }
      if (!routeMatches) {
        await client.query("ROLLBACK");
        return "expired";
      }
      if (!row.space_policy_current) {
        await client.query("ROLLBACK");
        return "expired";
      }
      // Only a freeform question is answered by text. Under a button prompt "да" is ordinary
      // conversation: Eve never turns it into a button decision, and consuming the row here left
      // the buttons dead and the turn waiting for its timeout.
      if (row.request_kind !== "question") {
        await client.query("ROLLBACK");
        return "not_applicable";
      }
      if (row.expected_telegram_user_id !== input.telegramUserId) {
        await client.query("ROLLBACK");
        return "forbidden";
      }
      if (!await resolveCurrentApprovalAuth(client, row)) {
        await client.query("ROLLBACK");
        return "forbidden";
      }
      const consumed = await client.query(
        `UPDATE telegram_hitl_approvals
            SET consumed_at = now()
          WHERE id = $1 AND consumed_at IS NULL`,
        [row.id],
      );
      if (consumed.rowCount !== 1) {
        await client.query("ROLLBACK");
        return "expired";
      }
      await client.query(
        `UPDATE conversation_sessions session
            SET pending_operation = EXISTS (
                  SELECT 1 FROM telegram_hitl_approvals pending
                   WHERE pending.application_session_id = session.id
                     AND pending.eve_session_id = $2
                     AND pending.consumed_at IS NULL
                ),
                pending_request_id = CASE
                  WHEN EXISTS (
                    SELECT 1 FROM telegram_hitl_approvals pending
                     WHERE pending.application_session_id = session.id
                       AND pending.eve_session_id = $2
                       AND pending.consumed_at IS NULL
                  ) THEN pending_request_id
                  ELSE NULL
                END,
                task_state = CASE
                  WHEN kind = 'task' AND NOT EXISTS (
                    SELECT 1 FROM telegram_hitl_approvals pending
                     WHERE pending.application_session_id = session.id
                       AND pending.eve_session_id = $2
                       AND pending.consumed_at IS NULL
                  ) THEN 'running'::conversation_task_state
                  ELSE task_state
                END
          WHERE session.id = $1`,
        [row.application_session_id, row.eve_session_id],
      );
      await client.query("COMMIT");
      return "authorized";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async clearForEveSession(applicationSessionId, eveSessionId) {
    await database().query(
      `DELETE FROM telegram_hitl_approvals
        WHERE application_session_id = $1 AND eve_session_id = $2`,
      [applicationSessionId, eveSessionId],
    );
  },

  async hasPendingForSession(applicationSessionId, eveSessionId) {
    const result = await database().query<{ pending: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM telegram_hitl_approvals a
           JOIN conversation_sessions s ON s.id = a.application_session_id
          WHERE a.application_session_id = $1
            AND a.eve_session_id = $2
            AND a.consumed_at IS NULL
            AND s.pending_operation = true
            AND s.retired_at IS NULL
            AND s.eve_session_id = a.eve_session_id
       ) AS pending`,
      [applicationSessionId, eveSessionId],
    );
    return result.rows[0]?.pending === true;
  },
};
