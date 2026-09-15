/**
 * Сбор доказательства состава чата.
 *
 * Экспорт:
 * - `AudienceProofPlan`: что удалось доказать и что мешает подтвердить состав.
 * - `planAudienceProof`: поимённая проверка присутствия и замыкающий счётчик.
 * - `commitAudienceProof`: запись доказательства и подтверждение привязки одной транзакцией.
 *
 * Состав берётся из `space_memberships` и `family_memberships`, присутствие — из ответов Telegram;
 * ни одно поле не приходит из текста модели и из аргументов вызывающего, кроме числа ботов: их
 * Bot API перечислить не даёт, поэтому оно объявляется человеком и входит в замыкание счётчика.
 *
 * Поимённая проверка говорит, что названные люди в чате есть. То, что в нём нет никого больше,
 * говорит только счётчик: `|состав| + боты = число участников`.
 */
import {resumeMigratedGroupJobs} from "../telegram-group-migration/resume-jobs.js";
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { recordAudienceProof } from "./telegram-audience-proof.js";

export interface AudienceProofDependencies {
  /** `getChatMemberCount`; `null` означает, что провайдер не ответил. */
  memberCount(chatId: string): Promise<number | null>;
  /** Статус участника чата либо `null` при отказе провайдера. */
  memberStatus(chatId: string, telegramUserId: string): Promise<string | null>;
  /** Идентификатор самого бота (`getMe`). */
  selfId(): Promise<string | null>;
}

export interface AudienceProofMember {
  readonly displayName: string;
  readonly present: boolean;
  readonly telegramUserId: string;
  readonly userId: string;
}

export interface AudienceProofPlan {
  readonly blockers: string[];
  readonly botIsAdministrator: boolean;
  readonly declaredBotCount: number;
  readonly familyId: string;
  readonly groupId: string;
  readonly members: AudienceProofMember[];
  readonly observedMemberCount: number | null;
  readonly policyVersion: number | null;
  readonly spaceId: string | null;
  readonly telegramChatId: string;
}

const PRESENT = ["creator", "administrator", "member", "restricted"];

interface BindingRow {
  family_id: string;
  group_id: string;
  policy_version: number;
  space_id: string;
  state: string;
}

export async function planAudienceProof(
  client: PoolClient,
  dependencies: AudienceProofDependencies,
  input: { declaredBotCount: number; telegramChatId: string },
): Promise<AudienceProofPlan> {
  const blockers: string[] = [];
  const binding = (await client.query<BindingRow>(
    `SELECT b.family_id, b.group_id, b.space_id, b.state, s.policy_version
       FROM space_bindings b
       JOIN telegram_groups g ON g.id = b.group_id AND g.family_id = b.family_id
       JOIN spaces s ON s.id = b.space_id AND s.family_id = b.family_id
      WHERE g.telegram_chat_id = $1 AND s.state = 'active'`,
    [input.telegramChatId],
  )).rows[0];
  if (!binding) {
    return {
      blockers: ["AGENT_SPACE_AUDIENCE_BINDING_MISSING"],
      botIsAdministrator: false,
      declaredBotCount: input.declaredBotCount,
      familyId: "",
      groupId: "",
      members: [],
      observedMemberCount: null,
      policyVersion: null,
      spaceId: null,
      telegramChatId: input.telegramChatId,
    };
  }

  // Аудитория области это её активные участники, которые сейчас состоят в семье.
  const expected = (await client.query<{
    display_name: string; telegram_user_id: string; user_id: string;
  }>(
    `SELECT users.display_name, users.telegram_user_id, members.user_id
       FROM space_memberships AS members
       JOIN family_memberships AS family
         ON family.family_id = members.family_id AND family.user_id = members.user_id
       JOIN users ON users.id = members.user_id
      WHERE members.family_id = $1 AND members.space_id = $2 AND members.state = 'active'
      ORDER BY users.telegram_user_id`,
    [binding.family_id, binding.space_id],
  )).rows;

  const members: AudienceProofMember[] = [];
  for (const person of expected) {
    const status = await dependencies.memberStatus(input.telegramChatId, person.telegram_user_id);
    if (status === null) blockers.push("AGENT_SPACE_AUDIENCE_MEMBER_UNKNOWN");
    members.push({
      displayName: person.display_name,
      present: status !== null && PRESENT.includes(status),
      telegramUserId: person.telegram_user_id,
      userId: person.user_id,
    });
  }
  const present = members.filter((member) => member.present);
  if (present.length === 0) blockers.push("AGENT_SPACE_AUDIENCE_EMPTY");

  const selfId = await dependencies.selfId();
  const selfStatus = selfId === null
    ? null
    : await dependencies.memberStatus(input.telegramChatId, selfId);
  const botIsAdministrator = selfStatus === "administrator" || selfStatus === "creator";
  // Без прав администратора бот видит не все сообщения чата, то есть не видит и его жизни.
  if (!botIsAdministrator) blockers.push("AGENT_SPACE_AUDIENCE_BOT_NOT_ADMINISTRATOR");

  const observedMemberCount = await dependencies.memberCount(input.telegramChatId);
  if (observedMemberCount === null) blockers.push("AGENT_SPACE_AUDIENCE_COUNT_UNKNOWN");
  // Замыкание: любой лишний читатель ломает равенство, даже если его имя нам неизвестно.
  else if (observedMemberCount !== present.length + input.declaredBotCount) {
    blockers.push("AGENT_SPACE_AUDIENCE_NOT_CLOSED");
  }

  return {
    blockers,
    botIsAdministrator,
    declaredBotCount: input.declaredBotCount,
    familyId: binding.family_id,
    groupId: binding.group_id,
    members,
    observedMemberCount,
    policyVersion: binding.policy_version,
    spaceId: binding.space_id,
    telegramChatId: input.telegramChatId,
  };
}

/**
 * Подтверждение владельца записывается вместе с активацией привязки: разделить их значит оставить
 * чат, который уже считается подтверждённым, без строки доказательства (или наоборот).
 *
 * Порядок навязан триггерами: привязка переходит в `active` только из неподтверждённого или
 * приостановленного состояния, а доказательство обязано назвать текущую версию политики.
 */
export async function commitAudienceProof(
  client: PoolClient,
  plan: AudienceProofPlan,
  confirmedBy: string,
): Promise<void> {
  if (plan.blockers.length > 0 || plan.spaceId === null || plan.policyVersion === null ||
    plan.observedMemberCount === null) {
    throw new AppError("AGENT_SPACE_AUDIENCE_NOT_PROVABLE", "Состав чата не доказан: подтверждать нечего");
  }
  const owner = await client.query(
    `SELECT 1 FROM family_memberships
      WHERE family_id = $1 AND user_id = $2 AND role IN ('owner','recovery_owner') FOR SHARE`,
    [plan.familyId, confirmedBy],
  );
  if (!owner.rowCount) {
    throw new AppError("AGENT_SPACE_AUDIENCE_CONFIRMER_INVALID", "Подтвердить состав чата может только владелец");
  }
  await recordAudienceProof(client, {
    botIsAdministrator: plan.botIsAdministrator,
    confirmedBy,
    declaredBotCount: plan.declaredBotCount,
    familyId: plan.familyId,
    groupId: plan.groupId,
    observedMemberCount: plan.observedMemberCount,
    policyVersion: plan.policyVersion,
    roster: plan.members.filter((member) => member.present).map((member) => member.userId),
    spaceId: plan.spaceId,
  });
  const activated = await client.query(
    `UPDATE space_bindings SET state = 'active'
      WHERE family_id = $1 AND group_id = $2 AND space_id = $3 AND state <> 'active'
      RETURNING group_id`,
    [plan.familyId, plan.groupId, plan.spaceId],
  );
  await client.query(
    `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
     VALUES ($1, $2, 'space.audience_proved', $3,
             jsonb_build_object('members', $4::integer, 'observed', $5::integer))`,
    [plan.familyId, confirmedBy, plan.groupId,
      plan.members.filter((member) => member.present).length, plan.observedMemberCount],
  );
  // Активация поднимает версию политики, поэтому доказательство перевыпускается под новой.
  if (activated.rowCount) {
    const current = (await client.query<{ policy_version: number }>(
      "SELECT policy_version FROM spaces WHERE id = $1", [plan.spaceId],
    )).rows[0];
    if (current && current.policy_version !== plan.policyVersion) {
      await client.query(
        "UPDATE telegram_chat_audience_proofs SET space_policy_version = $2 WHERE group_id = $1",
        [plan.groupId, current.policy_version],
      );
    }
  }
  await resumeMigratedGroupJobs(client,plan.familyId,plan.groupId);
}
