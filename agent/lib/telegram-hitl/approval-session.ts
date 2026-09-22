/** Lock prompt audience before approval/session rows, then compare the persisted policy. */
import type { PoolClient } from "pg";
import type { ApprovalAuthRow } from "./approval-auth.js";

export interface ApprovalRow extends ApprovalAuthRow {
  id: string;
  space_policy_current: boolean;
  callback_data: string[];
  callback_options: unknown;
  consumed_at: Date | null;
  consumed_callback_query_id: string | null;
  continuation_token: string;
  pending_operation: boolean;
  prompt_text: string | null;
  request_id: string;
  request_kind: "question" | "session-limit" | "tool-approval" | null;
  retired_at: Date | null;
  selected_option_id: string | null;
  session_eve_session_id: string | null;
  timed_out_at: Date | null;
}

// One Telegram prompt may carry every request of a multi-approval step; rows share the message.
export async function lockApprovals(
  client: PoolClient,
  telegramChatId: string,
  telegramMessageId: string,
): Promise<ApprovalRow[]> {
  // Same parent-before-session order as prepareTurn. Hold audience locks through consumption.
  const locked = await client.query<{ id: string }>(
    `SELECT p.id FROM spaces p WHERE p.id IN (
       SELECT s.space_id FROM telegram_hitl_approvals a
       JOIN conversation_sessions s ON s.id=a.application_session_id
       WHERE a.telegram_chat_id=$1 AND a.telegram_message_id=$2
         AND s.space_policy_version IS NOT NULL
     ) ORDER BY p.id FOR SHARE`, [telegramChatId, telegramMessageId],
  );
  const result = await client.query<ApprovalRow>(
    `SELECT a.application_session_id,
            a.callback_data,
            a.callback_options,
            a.consumed_at,
            a.consumed_callback_query_id,
            a.selected_option_id,
            a.timed_out_at,
            a.eve_session_id,
            a.expected_telegram_user_id,
            a.id,
            a.prompt_text,
            a.request_id,
            a.request_kind,
            a.telegram_chat_id,
            a.telegram_chat_type,
            a.telegram_conversation_id::text,
            a.telegram_message_id::text,
            a.telegram_message_thread_id::text,
            a.telegram_timeline_entry_id::text,
            s.continuation_token,
            s.eve_session_id AS session_eve_session_id,
            s.family_id,
            s.group_id,
            s.owner_user_id,
            s.pending_operation,
            s.retired_at,
            s.scope,
            s.space_id,
            s.space_policy_version,
            (s.space_policy_version IS NULL OR (s.space_id=ANY($3::uuid[]) AND EXISTS (
              SELECT 1 FROM spaces p WHERE p.id=s.space_id AND p.family_id=s.family_id
              AND p.state='active' AND p.policy_version=s.space_policy_version
            ))) AS space_policy_current
       FROM telegram_hitl_approvals a
       JOIN conversation_sessions s ON s.id = a.application_session_id
      WHERE a.telegram_chat_id = $1
        AND a.telegram_message_id = $2
      ORDER BY a.created_at, a.id
      FOR UPDATE OF a, s`,
    [telegramChatId, telegramMessageId, locked.rows.map((row) => row.id)],
  );
  return result.rows;
}

export function isPendingApproval(row: ApprovalRow): boolean {
  return row.consumed_at === null &&
    row.pending_operation &&
    row.retired_at === null &&
    row.session_eve_session_id === row.eve_session_id;
}

export function isReplayOfConsumedPress(
  rows: readonly ApprovalRow[],
  input: { callbackData: string; callbackQueryId?: string; telegramUserId: string },
  optionId: string,
): boolean {
  if (input.callbackQueryId === undefined) return false;
  // Every row of the prompt was consumed by exactly this press and this button, not by a timeout,
  // and the session still runs the Eve root that asked.
  return rows.every((candidate) =>
    candidate.consumed_at !== null &&
    candidate.timed_out_at === null &&
    candidate.consumed_callback_query_id === input.callbackQueryId &&
    candidate.selected_option_id === optionId &&
    candidate.expected_telegram_user_id === input.telegramUserId &&
    candidate.callback_data.includes(input.callbackData) &&
    candidate.retired_at === null &&
    candidate.space_policy_current &&
    candidate.session_eve_session_id === candidate.eve_session_id &&
    candidate.prompt_text !== null
  );
}
