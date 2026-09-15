/**
 * Обратная сторона переходного режима: пока он прежний, путь без области работает как раньше,
 * а после включения тот же путь обязан упасть громко. Без этого забытый непереведённый путь
 * молча останется прежним — именно через него и утечёт чужая запись.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { sessionRepository } from "../sessions/session-repository.js";
import { requireToolSpaceAccess } from "../sessions/session-tool-space-access.js";
import { bindGroupToSpace } from "./two-space-fixture.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const dbDescribe = enabled ? describe : describe.skip;

const TURN_AT = new Date("2026-09-11T12:00:00.000Z");
let familyId: string;
let ownerId: string;

function legacyTurn() {
  return {
    baseContinuationToken: "801::",
    familyId,
    groupId: null,
    kind: "canonical" as const,
    now: TURN_AT,
    scope: "personal" as const,
    telegramForumTopicId: null,
    userId: ownerId,
  };
}

function toolContext() {
  return {
    session: {
      auth: {
        current: {
          attributes: { applicationSessionId: crypto.randomUUID(), familyId, telegramChatType: "private" },
          authenticator: "telegram",
          principalId: ownerId,
          principalType: "user",
        },
      },
      id: "wrun_fail_closed",
    },
  } as never;
}

async function enableSpaces(): Promise<void> {
  // Ворота перехода: у каждой группы есть привязка, у семейной она подтверждена, живых сессий нет.
  const groupId = (await database().query<{ id: string }>(
    `INSERT INTO telegram_groups(family_id,telegram_chat_id,title,type,message_mode)
     VALUES($1,'-801','Семья','family_private','addressed_only') RETURNING id`,
    [familyId],
  )).rows[0]!.id;
  const spaceId = (await database().query<{ id: string }>(
    "INSERT INTO spaces(family_id,kind,title) VALUES($1,'shared','Пара') RETURNING id",
    [familyId],
  )).rows[0]!.id;
  await database().query(
    "INSERT INTO space_memberships(family_id,space_id,user_id,role,state) VALUES($1,$2,$3,'manager','active')",
    [familyId, spaceId, ownerId],
  );
  await database().query("UPDATE spaces SET state='active' WHERE id=$1", [spaceId]);
  await bindGroupToSpace(database(), familyId, groupId, spaceId);
  await database().query(
    "UPDATE family_space_runtime SET mode='spaces', reason='Переход' WHERE family_id=$1",
    [familyId],
  );
}

dbDescribe("unscoped paths after the switch", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE families,users CASCADE");
    familyId = (await database().query<{ id: string }>(
      "INSERT INTO families(name) VALUES('Fail closed family') RETURNING id",
    )).rows[0]!.id;
    ownerId = (await database().query<{ id: string }>(
      "INSERT INTO users(telegram_user_id,display_name) VALUES('801','Владелец') RETURNING id",
    )).rows[0]!.id;
    await database().query(
      "INSERT INTO family_memberships(family_id,user_id,role) VALUES($1,$2,'owner')",
      [familyId, ownerId],
    );
  });
  afterAll(closeDatabase);

  it("starts an unscoped turn while the family still runs the previous mode", async () => {
    const session = await sessionRepository.prepareTurn(legacyTurn());
    expect(session.id).toEqual(expect.any(String));
  });

  it("refuses to start an unscoped turn once the family switched", async () => {
    await enableSpaces();
    await expect(sessionRepository.prepareTurn(legacyTurn()))
      .rejects.toMatchObject({ code: "AGENT_SPACE_CONTEXT_REQUIRED" });
  });

  it("lets an unscoped tool run while the family still runs the previous mode", async () => {
    await expect(requireToolSpaceAccess(toolContext())).resolves.toBeUndefined();
  });

  it("refuses an unscoped tool once the family switched", async () => {
    await enableSpaces();
    await expect(requireToolSpaceAccess(toolContext()))
      .rejects.toMatchObject({ code: "AGENT_TOOL_SPACE_CONTEXT_INVALID" });
  });
});
