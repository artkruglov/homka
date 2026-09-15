/**
 * Durable no-resend barrier for native Telegram final output.
 *
 * Exports:
 * - `TelegramFinalDeliveryStart`: claimed, replayed, or terminal delivery state.
 * - `telegramFinalDeliveryRepository`: intent, chunk receipt, completion, suspension, and ambiguity.
 */
import { AppError } from "./app-error.js";
import { database } from "./database.js";
import type { TelegramChatType } from "eve/channels/telegram";

export type TelegramFinalDeliveryStart =
  | { deliveryId: string; deliveryToken: string; status: "started" }
  | { messages: Array<{ chatType: TelegramChatType; messageId: string }>; status: "delivered" }
  | { diagnosticCode: string; status: "ambiguous" | "failed" };

export const telegramFinalDeliveryRepository = {
  async start(input: {
    applicationSessionId: string;
    chunkCount: number;
    eveSessionId: string;
    eveTurnId: string;
    legacyChunkCount: number;
    legacyOutputHash: string;
    outputHash: string;
  }): Promise<TelegramFinalDeliveryStart> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO telegram_final_deliveries
           (eve_session_id, eve_turn_id, application_session_id, output_hash, expected_chunk_count)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (eve_session_id, eve_turn_id) DO NOTHING`,
        [input.eveSessionId, input.eveTurnId, input.applicationSessionId,
          input.outputHash, input.chunkCount],
      );
      const current = await client.query<{
        diagnostic_code: string | null;
        expected_chunk_count: number;
        id: string;
        output_hash: string;
        status: "ambiguous" | "delivered" | "failed" | "pending" | "started";
      }>(
        `SELECT id, output_hash, expected_chunk_count, status, diagnostic_code
         FROM telegram_final_deliveries
         WHERE eve_session_id = $1 AND eve_turn_id = $2 FOR UPDATE`,
        [input.eveSessionId, input.eveTurnId],
      );
      const delivery = current.rows[0]!;
      const exactContract = delivery.output_hash === input.outputHash &&
        delivery.expected_chunk_count === input.chunkCount;
      const legacyContract = delivery.output_hash === input.legacyOutputHash &&
        delivery.expected_chunk_count === input.legacyChunkCount;
      if (!exactContract && !legacyContract) {
        throw new AppError(
          "AGENT_TELEGRAM_FINAL_DELIVERY_REPLAY_MISMATCH",
          "Повтор финального ответа не совпадает с исходной доставкой Telegram",
        );
      }
      if (!exactContract && legacyContract && delivery.status === "pending") {
        // An unsent pre-v0.14 intent can safely adopt the new transport presentation before claim.
        await client.query(
          `UPDATE telegram_final_deliveries
           SET output_hash = $2, expected_chunk_count = $3, updated_at = now() WHERE id = $1`,
          [delivery.id, input.outputHash, input.chunkCount],
        );
        delivery.output_hash = input.outputHash;
        delivery.expected_chunk_count = input.chunkCount;
      }
      if (delivery.status === "delivered") {
        const chunks = await client.query<{
          telegram_chat_type: TelegramChatType;
          telegram_message_id: string;
        }>(
          `SELECT telegram_message_id::text, telegram_chat_type
           FROM telegram_final_delivery_chunks WHERE delivery_id = $1 ORDER BY ordinal`,
          [delivery.id],
        );
        await client.query("COMMIT");
        return {
          messages: chunks.rows.map((row) => ({
            chatType: row.telegram_chat_type,
            messageId: row.telegram_message_id,
          })),
          status: "delivered",
        };
      }
      if (delivery.status === "started") {
        const code = "AGENT_TELEGRAM_FINAL_DELIVERY_AMBIGUOUS";
        await client.query(
          `UPDATE telegram_final_deliveries
           SET status = 'ambiguous', delivery_token = NULL, diagnostic_code = $2,
               completed_at = now(), updated_at = now() WHERE id = $1`,
          [delivery.id, code],
        );
        await client.query("COMMIT");
        return { diagnosticCode: code, status: "ambiguous" };
      }
      if (delivery.status === "ambiguous" || delivery.status === "failed") {
        await client.query("COMMIT");
        return {
          diagnosticCode: delivery.diagnostic_code ?? "AGENT_TELEGRAM_FINAL_DELIVERY_AMBIGUOUS",
          status: delivery.status,
        };
      }
      const started = await client.query<{ id: string; delivery_token: string }>(
        `UPDATE telegram_final_deliveries
         SET status = 'started', delivery_token = gen_random_uuid(), started_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'pending' RETURNING id, delivery_token::text`,
        [delivery.id],
      );
      await client.query("COMMIT");
      return {
        deliveryId: started.rows[0]!.id,
        deliveryToken: started.rows[0]!.delivery_token,
        status: "started",
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  /**
   * Приостановка идёт до заявки на отправку: если бы она оставляла `status='started'`, любой
   * повтор навсегда стал бы `ambiguous`, то есть неизвестным исходом вместо честного отказа.
   * Уже начатую или доставленную строку приостановка не трогает: отправленное не отзывается.
   */
  async suspend(input: {
    applicationSessionId: string;
    chunkCount: number;
    diagnosticCode: string;
    eveSessionId: string;
    eveTurnId: string;
    outputHash: string;
  }): Promise<void> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO telegram_final_deliveries
           (eve_session_id, eve_turn_id, application_session_id, output_hash, expected_chunk_count)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (eve_session_id, eve_turn_id) DO NOTHING`,
        [input.eveSessionId, input.eveTurnId, input.applicationSessionId,
          input.outputHash, input.chunkCount],
      );
      await client.query(
        `UPDATE telegram_final_deliveries
            SET status = 'failed', delivery_token = NULL, diagnostic_code = $3,
                started_at = now(), completed_at = now(), updated_at = now()
          WHERE eve_session_id = $1 AND eve_turn_id = $2 AND status = 'pending'`,
        [input.eveSessionId, input.eveTurnId, input.diagnosticCode],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async confirmChunk(input: {
    chatType: TelegramChatType;
    contentHash: string;
    deliveryId: string;
    deliveryToken: string;
    messageId: string;
    ordinal: number;
  }): Promise<void> {
    const result = await database().query(
      `INSERT INTO telegram_final_delivery_chunks
         (delivery_id, ordinal, content_hash, telegram_message_id, telegram_chat_type)
       SELECT id, $3, $4, $5::bigint, $6
       FROM telegram_final_deliveries
       WHERE id = $1 AND status = 'started' AND delivery_token = $2
         AND $3 >= 0 AND $3 < expected_chunk_count`,
      [input.deliveryId, input.deliveryToken, input.ordinal, input.contentHash,
        input.messageId, input.chatType],
    );
    if (!result.rowCount) {
      throw new AppError(
        "AGENT_TELEGRAM_FINAL_DELIVERY_STALE",
        "Подтверждение Telegram относится к устаревшей доставке",
      );
    }
  },

  async complete(deliveryId: string, deliveryToken: string): Promise<void> {
    const result = await database().query(
      `UPDATE telegram_final_deliveries AS delivery
       SET status = 'delivered', delivery_token = NULL, completed_at = now(), updated_at = now()
       WHERE delivery.id = $1 AND delivery.status = 'started' AND delivery.delivery_token = $2
         AND delivery.expected_chunk_count = (
           SELECT count(*) FROM telegram_final_delivery_chunks AS chunk
           WHERE chunk.delivery_id = delivery.id
         )`,
      [deliveryId, deliveryToken],
    );
    if (!result.rowCount) {
      throw new AppError(
        "AGENT_TELEGRAM_FINAL_DELIVERY_INCOMPLETE",
        "Telegram не подтвердил все части финального ответа",
      );
    }
  },

  async fail(
    deliveryId: string,
    deliveryToken: string,
    diagnosticCode: string,
    ambiguous: boolean,
  ): Promise<void> {
    await database().query(
      `UPDATE telegram_final_deliveries
       SET status = $3, delivery_token = NULL, diagnostic_code = $4,
           completed_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'started' AND delivery_token = $2`,
      [deliveryId, deliveryToken, ambiguous ? "ambiguous" : "failed", diagnosticCode],
    );
  },

  async shouldSuppressFailureMessage(eveSessionId: string, eveTurnId: string): Promise<boolean> {
    const result = await database().query<{ status: string }>(
      `SELECT status FROM telegram_final_deliveries
       WHERE eve_session_id = $1 AND eve_turn_id = $2`,
      [eveSessionId, eveTurnId],
    );
    const status = result.rows[0]?.status;
    return status === "started" || status === "delivered" || status === "ambiguous";
  },
};
