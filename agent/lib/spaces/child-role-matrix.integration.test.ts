/**
 * Детская роль проверяется на настоящей identity, а не на обещании в промпте.
 *
 * Роль `child` объявлена в матрице прав давно, но пока её никому не выдают, «ограничено» значит
 * ровно столько, сколько проверено. Здесь ребёнок — живое членство в общей области, и каждый
 * путь записи спрашивается отдельно: читать можно, менять нельзя, публиковать нельзя.
 *
 * Дела проверяются отдельно: видимость остаётся по личности; чтение, предложение и завершение
 * своего дела разрешены без общего write, а изменение требует права в области самой задачи.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { careAreaRepository } from "../care-areas/care-area-repository.js";
import { closeDatabase, database } from "../database.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { reminderRepository } from "../reminders/reminder-repository.js";
import type { ReminderAuthorization } from "../reminders/reminder-context.js";
import { shoppingRepository } from "../shopping/shopping-repository.js";
import { sharedTaskRepository } from "../shared-task-repository.js";
import { createTwoSpaceFixture, currentSpacePolicyVersion, type TwoSpaceFixture } from "./two-space-fixture.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const dbDescribe = enabled ? describe : describe.skip;

let fixture: TwoSpaceFixture;

async function childAuth(group = false): Promise<MemoryAuthorization> {
  return {
    familyId: fixture.familyId,
    groupId: group ? fixture.groupId : null,
    role: "member",
    scopes: group ? ["family"] : ["personal", "family"],
    space: {
      policyVersion: await currentSpacePolicyVersion(fixture.pairSpaceId),
      spaceId: fixture.pairSpaceId,
    },
    telegramActorId: fixture.spouse.telegramUserId,
    telegramActorKind: "telegram_user",
    telegramUserId: fixture.spouse.telegramUserId,
    userId: fixture.spouse.userId,
  };
}

async function childReminderAuth(): Promise<ReminderAuthorization> {
  return {
    familyId: fixture.familyId,
    forumTopicId: null,
    groupId: null,
    groupType: null,
    messageThreadId: null,
    role: "member",
    space: {
      policyVersion: await currentSpacePolicyVersion(fixture.pairSpaceId),
      spaceId: fixture.pairSpaceId,
    },
    telegramChatId: fixture.spouse.telegramUserId,
    telegramChatType: "private",
    userId: fixture.spouse.userId,
  };
}

dbDescribe("child role", () => {
  it("can read, propose and complete its own task without general write permission",async()=>{
    const created=await sharedTaskRepository.execute(await childAuth(true),{action:"create",title:"Собрать рюкзак"},randomUUID());
    expect(created.task?.status).toBe("accepted");
    // Selecting a personal space with broader rights cannot bypass the task's actual child role.
    const personal=(await database().query("INSERT INTO spaces(family_id,kind,title,owner_user_id) VALUES($1,'personal','Моё',$2) RETURNING id",[fixture.familyId,fixture.spouse.userId])).rows[0].id;
    await database().query("INSERT INTO space_memberships(family_id,space_id,user_id,role,state) VALUES($1,$2,$3,'manager','active')",[fixture.familyId,personal,fixture.spouse.userId]);
    await database().query("UPDATE spaces SET state='active' WHERE id=$1",[personal]);
    const privateAuth={...await childAuth(),space:{spaceId:personal,policyVersion:await currentSpacePolicyVersion(personal)}};
    await expect(sharedTaskRepository.execute(privateAuth,{action:"update",id:created.task!.id,version:1,title:"Обход через личное"},randomUUID()))
      .rejects.toThrow(/AGENT_SPACE_ACCESS_DENIED/u);
    const listed=await sharedTaskRepository.execute(await childAuth(),{action:"list"},randomUUID());
    expect(listed.tasks?.map(task=>task.id)).toContain(created.task!.id);
    await expect(sharedTaskRepository.execute(await childAuth(true),{action:"update",id:created.task!.id,version:1,title:"Чужой план"},randomUUID()))
      .rejects.toThrow(/AGENT_SPACE_ACCESS_DENIED/u);
    const completed=await sharedTaskRepository.execute(await childAuth(),{action:"complete",id:created.task!.id},randomUUID());
    expect(completed.task?.status).toBe("completed");
  });

  it("cannot complete another person's task even when both can read the space",async()=>{
    const id=(await database().query(`INSERT INTO shared_tasks(family_id,space_id,scope,creator_telegram_id,assignee_telegram_id,title,status)
      VALUES($1,$2,'family',$3,$3,'Взрослое дело','accepted') RETURNING id`,[fixture.familyId,fixture.pairSpaceId,fixture.owner.telegramUserId])).rows[0].id;
    await expect(sharedTaskRepository.execute(await childAuth(true),{action:"complete",id},randomUUID())).rejects.toThrow();
    expect((await database().query("SELECT status FROM shared_tasks WHERE id=$1",[id])).rows[0].status).toBe("accepted");
  });
  beforeEach(async () => {
    await database().query(
      "TRUNCATE care_areas, shopping_items, reminders, spaces, telegram_groups, family_memberships, users, families CASCADE",
    );
    fixture = await createTwoSpaceFixture("child-role");
    await database().query(
      "UPDATE space_memberships SET role='child' WHERE space_id=$1 AND user_id=$2",
      [fixture.pairSpaceId, fixture.spouse.userId],
    );
    await database().query(
      "UPDATE family_space_runtime SET mode='spaces', cutover_at=now(), reason='Переход' WHERE family_id=$1",
      [fixture.familyId],
    );
    await database().query(
      `INSERT INTO user_notification_settings(user_id,timezone,quiet_start,quiet_end)
       VALUES($1,'UTC',NULL,NULL)`,
      [fixture.spouse.userId],
    );
  });
  afterAll(closeDatabase);

  it("refuses every write path of the area to a child", async () => {
    await expect(shoppingRepository.execute(await childAuth(),
      { action: "add", listName: "Продукты", title: "Конфеты" }, randomUUID()))
      .rejects.toThrow(/AGENT_SPACE_ACCESS_DENIED/u);

    await expect(careAreaRepository.execute(await childAuth(true), { action: "create", title: "Машина" }))
      .rejects.toThrow(/AGENT_SPACE_ACCESS_DENIED/u);

    await expect(reminderRepository.create(await childReminderAuth(), {
      content: "Мультики",
      firstRunAt: new Date(Date.now() + 3_600_000),
      operationKey: randomUUID(),
      recurrence: null,
      scope: "personal",
      timezone: "UTC",
    })).rejects.toThrow(/AGENT_SPACE_ACCESS_DENIED/u);
  });

  it("still lets a child read what the area shows them", async () => {
    await database().query(
      `INSERT INTO shopping_items(family_id,space_id,list_name,title,added_by_telegram_id)
       VALUES($1,$2,'Продукты','Молоко',$3)`,
      [fixture.familyId, fixture.pairSpaceId, fixture.owner.telegramUserId],
    );
    const listed = await shoppingRepository.execute(await childAuth(), { action: "list" }, "read");
    expect(listed.items?.map((item) => item.title)).toEqual(["Молоко"]);
    // Кто что ведёт, ребёнок тоже видит: иначе «ограничен» превратилось бы в «ничего не знает».
    await expect(careAreaRepository.execute(await childAuth(true), { action: "list" }))
      .resolves.toMatchObject({ areas: [] });
    await expect(reminderRepository.list(await childReminderAuth(), { limit: 10 }))
      .resolves.toMatchObject({ items: [] });
  });
});
