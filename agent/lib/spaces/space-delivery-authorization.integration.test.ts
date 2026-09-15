/**
 * Право инициатора и адресат сообщения — разные проверки. Ход может быть полностью законным, а
 * чат за время его работы получить нового участника: содержимое области уходит только в
 * подтверждённый состав.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { authorizeSpaceDelivery } from "./space-delivery-authorization.js";
import { recordAudienceProof } from "./telegram-audience-proof.js";
import {
  createTwoSpaceFixture,
  currentSpacePolicyVersion,
  type TwoSpaceFixture,
} from "./two-space-fixture.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const dbDescribe = enabled ? describe : describe.skip;

async function enableSpaces(fixture: TwoSpaceFixture): Promise<void> {
  await database().query(
    "UPDATE family_space_runtime SET mode='spaces', cutover_at=now(), reason='Переход' WHERE family_id=$1",
    [fixture.familyId],
  );
}

async function prove(fixture: TwoSpaceFixture): Promise<void> {
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
}

async function groupDelivery(fixture: TwoSpaceFixture, withSpace = true) {
  return await authorizeSpaceDelivery({
    chatType: "supergroup",
    familyId: fixture.familyId,
    groupId: fixture.groupId,
    now: new Date(),
    ...(withSpace
      ? { space: { policyVersion: await currentSpacePolicyVersion(fixture.pairSpaceId), spaceId: fixture.pairSpaceId } }
      : {}),
    userId: fixture.owner.userId,
  });
}

dbDescribe("space delivery authorization", () => {
  let fixture: TwoSpaceFixture;

  beforeEach(async () => {
    await database().query(
      "TRUNCATE spaces, telegram_groups, family_memberships, users, families CASCADE",
    );
    fixture = await createTwoSpaceFixture("delivery-auth");
  });
  afterAll(closeDatabase);

  it("does not change anything while the family runs the previous mode", async () => {
    await expect(groupDelivery(fixture)).resolves.toEqual({ allowed: true });
    await expect(groupDelivery(fixture, false)).resolves.toEqual({ allowed: true });
  });

  it("refuses a group answer until the chat audience is proved", async () => {
    await enableSpaces(fixture);

    await expect(groupDelivery(fixture)).resolves.toEqual({
      allowed: false, code: "AGENT_SPACE_DELIVERY_AUDIENCE_UNPROVEN",
    });
    await prove(fixture);
    await expect(groupDelivery(fixture)).resolves.toEqual({ allowed: true });
  });

  it("stops trusting the proof as soon as the audience of the space changes", async () => {
    await enableSpaces(fixture);
    await prove(fixture);
    // Отзыв членства поднимает версию политики, и прежнее доказательство больше не её.
    await database().query(
      "UPDATE space_memberships SET state='revoked' WHERE space_id=$1 AND user_id=$2",
      [fixture.pairSpaceId, fixture.spouse.userId],
    );

    await expect(groupDelivery(fixture)).resolves.toEqual({
      allowed: false, code: "AGENT_SPACE_DELIVERY_AUDIENCE_UNPROVEN",
    });
  });

  it("refuses a turn that carries no area and allows a private chat without a roster", async () => {
    await enableSpaces(fixture);
    await expect(groupDelivery(fixture, false)).resolves.toEqual({
      allowed: false, code: "AGENT_SPACE_DELIVERY_CONTEXT_REQUIRED",
    });

    const personal = (await database().query<{ id: string }>(
      `INSERT INTO spaces(family_id,kind,title,owner_user_id) VALUES($1,'personal','Личное',$2)
       RETURNING id`, [fixture.familyId, fixture.owner.userId],
    )).rows[0]!.id;
    await database().query(
      "INSERT INTO space_memberships(family_id,space_id,user_id,role,state) VALUES($1,$2,$3,'manager','active')",
      [fixture.familyId, personal, fixture.owner.userId],
    );
    await database().query("UPDATE spaces SET state='active' WHERE id=$1", [personal]);

    // У личного чата аудитория это сам аккаунт: доказывать в нём некого.
    await expect(authorizeSpaceDelivery({
      chatType: "private",
      familyId: fixture.familyId,
      groupId: null,
      now: new Date(),
      space: { policyVersion: await currentSpacePolicyVersion(personal), spaceId: personal },
      userId: fixture.owner.userId,
    })).resolves.toEqual({ allowed: true });
  });
});
