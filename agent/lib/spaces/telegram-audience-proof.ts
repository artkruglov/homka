/**
 * Доказанный состав Telegram-чата.
 *
 * Экспорт:
 * - `AUDIENCE_PROOF_FRESHNESS_MILLISECONDS`: окно, в котором доказательство считается свежим.
 * - `AudienceProofInput`: поимённый состав и замыкающий счётчик, подтверждённые владельцем.
 * - `recordAudienceProof`: сохраняет доказательство для текущей версии политики области.
 * - `readAudienceProof`: строка доказательства чата либо `null`.
 * - `noteObservedMemberCount`: сверяет наблюдаемый счётчик и отзывает разрешение при расхождении.
 * - `isAudienceProven`: годится ли доказательство для доставки прямо сейчас.
 *
 * Поимённая проверка доказывает, что каждый названный человек в чате есть, и ничего не говорит о
 * том, что в нём нет никого больше. Замыкает аудиторию счётчик участников, поэтому он хранится в
 * той же строке и сверяется отдельно от имён.
 *
 * Ничто здесь не приходит из текста модели: состав берётся из `family_memberships`, присутствие —
 * из ответов Telegram, а подтверждает его владелец кнопкой в своём личном чате.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";

/** Полная пересверка нужна не чаще, чем меняется состав: счётчик ловит вход и выход за минуту. */
export const AUDIENCE_PROOF_FRESHNESS_MILLISECONDS = 15 * 60_000;

export interface AudienceProofInput {
  readonly botIsAdministrator: boolean;
  readonly confirmedBy: string;
  readonly declaredBotCount: number;
  readonly familyId: string;
  readonly groupId: string;
  readonly observedMemberCount: number;
  readonly policyVersion: number;
  /** Идентификаторы людей из `family_memberships`, чьё присутствие подтверждено поимённо. */
  readonly roster: readonly string[];
  readonly spaceId: string;
}

export interface AudienceProofRow {
  readonly botIsAdministrator: boolean;
  readonly checkedAt: Date;
  readonly observedMemberCount: number;
  readonly policyVersion: number;
  readonly roster: string[];
  readonly spaceId: string;
}

export async function recordAudienceProof(
  client: PoolClient,
  input: AudienceProofInput,
): Promise<void> {
  // Строка одна на чат: доказательство нельзя накопить, его можно только заменить целиком.
  await client.query(
    `INSERT INTO telegram_chat_audience_proofs
       (group_id, family_id, space_id, space_policy_version, roster, declared_bot_count,
        observed_member_count, bot_is_administrator, confirmed_by)
     VALUES ($1,$2,$3,$4,$5::uuid[],$6,$7,$8,$9)
     ON CONFLICT (group_id) DO UPDATE SET
       space_id = EXCLUDED.space_id, space_policy_version = EXCLUDED.space_policy_version,
       roster = EXCLUDED.roster, declared_bot_count = EXCLUDED.declared_bot_count,
       observed_member_count = EXCLUDED.observed_member_count,
       bot_is_administrator = EXCLUDED.bot_is_administrator,
       confirmed_by = EXCLUDED.confirmed_by, proved_at = now(), checked_at = now()`,
    [
      input.groupId, input.familyId, input.spaceId, input.policyVersion,
      [...input.roster], input.declaredBotCount, input.observedMemberCount,
      input.botIsAdministrator, input.confirmedBy,
    ],
  );
}

export async function readAudienceProof(
  client: PoolClient,
  groupId: string,
): Promise<AudienceProofRow | null> {
  const row = (await client.query<{
    bot_is_administrator: boolean; checked_at: Date; observed_member_count: number;
    roster: string[]; space_id: string; space_policy_version: number;
  }>(
    `SELECT bot_is_administrator, checked_at, observed_member_count, roster, space_id,
            space_policy_version
       FROM telegram_chat_audience_proofs WHERE group_id = $1`,
    [groupId],
  )).rows[0];
  return row === undefined ? null : {
    botIsAdministrator: row.bot_is_administrator,
    checkedAt: row.checked_at,
    observedMemberCount: row.observed_member_count,
    policyVersion: row.space_policy_version,
    roster: row.roster,
    spaceId: row.space_id,
  };
}

/**
 * Расхождение счётчика означает, что в чате кто-то появился или исчез. Строка доказательства
 * удаляется, а привязка возвращается в неподтверждённое состояние: существующий триггер поднимет
 * версию политики, и дальше всё написанное срабатывает само — устаревший контекст в инструментах и
 * репозиториях, пересоздание хода, приостановка расписаний и напоминаний.
 */
export async function noteObservedMemberCount(
  client: PoolClient,
  input: { count: number; familyId: string; groupId: string; now: Date },
): Promise<"matched" | "revoked" | "unproven"> {
  const proof = await readAudienceProof(client, input.groupId);
  if (proof === null) return "unproven";
  if (proof.observedMemberCount === input.count) {
    await client.query(
      "UPDATE telegram_chat_audience_proofs SET checked_at = $2 WHERE group_id = $1",
      [input.groupId, input.now],
    );
    return "matched";
  }
  await client.query("DELETE FROM telegram_chat_audience_proofs WHERE group_id = $1", [input.groupId]);
  await client.query(
    `UPDATE space_bindings SET state = 'pending_verification'
      WHERE family_id = $1 AND group_id = $2 AND state = 'active'`,
    [input.familyId, input.groupId],
  );
  await client.query(
    `INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
     VALUES ($1, 'space.audience_revoked', $2,
             jsonb_build_object('observed', $3::integer, 'proved', $4::integer))`,
    [input.familyId, input.groupId, input.count, proof.observedMemberCount],
  );
  return "revoked";
}

/**
 * Перед доставкой к Telegram не обращаются: строка доказательства читается в той же транзакции,
 * что и проверка доступа к области. Свежесть обеспечивает минутный счётчик на старте хода.
 */
export async function isAudienceProven(
  client: PoolClient,
  input: { groupId: string; now: Date; policyVersion: number; spaceId: string },
): Promise<boolean> {
  const proof = await readAudienceProof(client, input.groupId);
  if (proof === null) return false;
  return proof.spaceId === input.spaceId &&
    proof.policyVersion === input.policyVersion &&
    proof.botIsAdministrator &&
    input.now.getTime() - proof.checkedAt.getTime() < AUDIENCE_PROOF_FRESHNESS_MILLISECONDS;
}

export function requireDeclaredBotCount(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 50) {
    throw new AppError("AGENT_SPACE_AUDIENCE_BOT_COUNT_INVALID", "Не удалось определить число ботов в чате");
  }
  return value;
}
