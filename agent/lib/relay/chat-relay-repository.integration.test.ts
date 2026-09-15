/**
 * Передача сообщения в общий чат по просьбе человека: адресат берётся из его собственных чатов,
 * живое членство проверяется перед самой отправкой, повтор того же вызова не отправляет второе
 * сообщение, а неподтверждённый состав чата останавливает передачу.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDatabase, database } from "../database.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { createChatRelay } from "./chat-relay-repository.js";
import { recordAudienceProof } from "../spaces/telegram-audience-proof.js";
import {
  createTwoSpaceFixture,
  currentSpacePolicyVersion,
  type TwoSpaceFixture,
} from "../spaces/two-space-fixture.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const dbDescribe = enabled ? describe : describe.skip;

let fixture: TwoSpaceFixture;

function author(): MemoryAuthorization {
  return {
    familyId: fixture.familyId,
    groupId: null,
    role: "owner",
    scopes: ["personal", "family"],
    telegramActorId: fixture.owner.telegramUserId,
    telegramActorKind: "telegram_user",
    telegramUserId: fixture.owner.telegramUserId,
    userId: fixture.owner.userId,
  };
}

function relayWith(options: { member?: boolean; send?: () => Promise<string> } = {}) {
  const send = vi.fn().mockImplementation(options.send ?? (async () => "4242"));
  const membership = vi.fn().mockResolvedValue(options.member ?? true);
  return { membership, relay: createChatRelay({ membership, send }), send };
}

dbDescribe("chat message relay", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE chat_message_relays, spaces, telegram_groups, family_memberships, users, families CASCADE",
    );
    fixture = await createTwoSpaceFixture("relay");
  });
  afterAll(closeDatabase);

  it("sends the confirmed text once and signs it with its author", async () => {
    const { relay, send } = relayWith();

    const outcome = await relay(author(), { targetRef: fixture.groupId, text: "Буду в 19:00" }, "relay-1");

    expect(outcome).toMatchObject({ delivered: true, replayed: false, targetTitle: "Пара" });
    expect(send).toHaveBeenCalledWith({
      chatId: fixture.telegramChatId,
      text: "Передаю по просьбе Владелец:\n\nБуду в 19:00",
    });
    // Повтор того же вызова не отправляет второе сообщение: исход уже записан.
    const again = await relay(author(), { targetRef: fixture.groupId, text: "Буду в 19:00" }, "relay-1");
    expect(again).toMatchObject({ delivered: true, replayed: true });
    expect(send).toHaveBeenCalledOnce();
  });

  it("refuses a chat the person no longer belongs to", async () => {
    const { relay, send } = relayWith({ member: false });

    await expect(relay(author(), { targetRef: fixture.groupId, text: "Привет" }, "relay-2"))
      .rejects.toThrowError(/AGENT_RELAY_TARGET_UNAVAILABLE/);
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps an ambiguous send terminal instead of repeating it", async () => {
    const { relay, send } = relayWith({ send: async () => { throw new Error("network"); } });

    await expect(relay(author(), { targetRef: fixture.groupId, text: "Привет" }, "relay-3"))
      .rejects.toThrowError(/network/);
    const stored = await database().query<{ diagnostic_code: string; status: string }>(
      "SELECT diagnostic_code,status FROM chat_message_relays WHERE operation_key='relay-3'",
    );
    expect(stored.rows[0]).toMatchObject({
      diagnostic_code: "AGENT_RELAY_DELIVERY_AMBIGUOUS", status: "failed",
    });
    // Тот же ключ второй раз не отправляет ничего и не выдаёт неизвестное за отказ: после
    // обрыва сети сообщение могло уйти, и человек решает сам, писать ли заново.
    await expect(relay(author(), { targetRef: fixture.groupId, text: "Привет" }, "relay-3"))
      .rejects.toThrowError(/AGENT_RELAY_OUTCOME_UNKNOWN/);
    expect(send).toHaveBeenCalledOnce();
  });

  it("does not call a half-written claim a failure, and refuses the same key for another chat", async () => {
    const { relay, send } = relayWith();
    // Процесс погиб между заявкой и отправкой: строка осталась в 'started', и что стало с
    // сообщением, неизвестно никому.
    await database().query(
      `INSERT INTO chat_message_relays(family_id,space_id,group_id,author_user_id,operation_key,text)
       VALUES($1,NULL,$2,$3,'relay-5','Передаю по просьбе Владелец:\n\nПривет')`,
      [fixture.familyId, fixture.groupId, fixture.owner.userId],
    );
    await expect(relay(author(), { targetRef: fixture.groupId, text: "Привет" }, "relay-5"))
      .rejects.toThrowError(/AGENT_RELAY_OUTCOME_UNKNOWN/);
    expect(send).not.toHaveBeenCalled();

    // Тот же ключ с другим адресатом это другая просьба: отдавать по нему чужую доставку нельзя.
    const other = (await database().query<{ id: string }>(
      `INSERT INTO telegram_groups(family_id,telegram_chat_id,title,type,message_mode)
       VALUES($1,'-90909','Родня','family_private','addressed_only') RETURNING id`,
      [fixture.familyId],
    )).rows[0]!.id;
    await relay(author(), { targetRef: fixture.groupId, text: "Буду в 19:00" }, "relay-6");
    await expect(relay(author(), { targetRef: other, text: "Буду в 19:00" }, "relay-6"))
      .rejects.toThrowError(/AGENT_RELAY_OPERATION_CONFLICT/);
  });

  it("does not relay into a chat whose audience is not proved", async () => {
    await database().query(
      "UPDATE family_space_runtime SET mode='spaces', cutover_at=now(), reason='Переход' WHERE family_id=$1",
      [fixture.familyId],
    );
    const { relay, send } = relayWith();

    await expect(relay(author(), { targetRef: fixture.groupId, text: "Привет" }, "relay-4"))
      .rejects.toThrowError(/AGENT_RELAY_AUDIENCE_UNPROVEN/);
    expect(send).not.toHaveBeenCalled();

    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await recordAudienceProof(client, {
        botIsAdministrator: true,
        confirmedBy: fixture.owner.userId,
        declaredBotCount: 1,
        familyId: fixture.familyId,
        groupId: fixture.groupId,
        observedMemberCount: 3,
        policyVersion: await currentSpacePolicyVersion(fixture.pairSpaceId),
        roster: [fixture.owner.userId, fixture.spouse.userId],
        spaceId: fixture.pairSpaceId,
      });
      await client.query("COMMIT");
    } finally { client.release(); }

    await expect(relay(author(), { targetRef: fixture.groupId, text: "Привет" }, "relay-5"))
      .resolves.toMatchObject({ delivered: true });
  });
});
