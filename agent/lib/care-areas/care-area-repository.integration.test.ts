/**
 * Область заботы: хозяин появляется только по согласию, отказ возвращает её в ничьи, и ни одно
 * действие не назначает человека за него.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { careAreaRepository as areas } from "./care-area-repository.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { sharedTaskRepository } from "../shared-task-repository.js";
import { createTwoSpaceFixture, twoSpaceMemoryAuthorization, type TwoSpaceFixture } from "../spaces/two-space-fixture.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const dbDescribe = enabled ? describe : describe.skip;

let fixture: TwoSpaceFixture;

function auth(person: TwoSpaceFixture["owner"], group = true): MemoryAuthorization {
  return {
    familyId: fixture.familyId,
    groupId: group ? fixture.groupId : null,
    role: "member",
    scopes: group ? ["family"] : ["personal", "family"],
    telegramActorId: person.telegramUserId,
    telegramActorKind: "telegram_user",
    telegramUserId: person.telegramUserId,
    userId: person.userId,
  };
}

async function participantRef(name: string, reader = fixture.owner): Promise<string> {
  const participants = (await sharedTaskRepository.execute(
    auth(reader), { action: "participants" }, "read")).participants!;
  return participants.find((person) => person.name === name)!.participantRef;
}

const spouseRef = () => participantRef("Супруга");
const ownerRef = () => participantRef("Владелец", fixture.spouse);

dbDescribe("care areas", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE care_areas, shared_tasks, spaces, telegram_groups, family_memberships, users, families CASCADE",
    );
    fixture = await createTwoSpaceFixture("care-area");
  });
  afterAll(closeDatabase);

  it("does not reveal a neighbouring care-area title through duplicate rejection", async () => {
    const pair = await twoSpaceMemoryAuthorization({ as: fixture.spouse,
      spaceId: fixture.pairSpaceId, chat: "group", fixture });
    const household = await twoSpaceMemoryAuthorization({ as: fixture.owner,
      spaceId: fixture.householdSpaceId, chat: "private", fixture });
    await areas.execute(household, { action: "create", title: "Машина" });
    await expect(areas.execute(pair, { action: "create", title: "Машина" }))
      .resolves.toMatchObject({ area: { title: "Машина" } });
    await expect(areas.execute(pair, { action: "create", title: "машина" }))
      .rejects.toThrow(/AGENT_CARE_AREA_DUPLICATE/u);
  });

  it("isolates care areas in two shared spaces for reads and mutations", async () => {
    const authorization = (as: TwoSpaceFixture["owner"], spaceId: string, chat: "group" | "private") =>
      twoSpaceMemoryAuthorization({ as, spaceId, chat, fixture });
    const pair = await authorization(fixture.owner, fixture.pairSpaceId, "group");
    const household = await authorization(fixture.owner, fixture.householdSpaceId, "private");
    const first = (await areas.execute(pair, { action: "create", title: "Дети" })).area!;
    const secret = (await areas.execute(household, { action: "create", title: "Сюрприз" })).area!;
    expect((await areas.execute(pair, { action: "list" })).areas!.map(a => a.id)).toEqual([first.id]);
    const spouse = await authorization(fixture.spouse, fixture.pairSpaceId, "private");
    expect((await areas.execute(spouse, { action: "list" })).areas!.map(a => a.id)).toEqual([first.id]);
    expect((await areas.execute(household, { action: "list" })).areas).toHaveLength(2);
    await expect(areas.execute(pair, { action: "retire", id: secret.id, version: secret.version }))
      .rejects.toThrow(/AGENT_TASK_ACCESS_DENIED|AGENT_SPACE_ACCESS_DENIED/u);
    await expect(sharedTaskRepository.execute(pair,
      { action: "create", title: "Чужая область", careAreaRef: secret.id }, "hidden-care"))
      .rejects.toThrow(/AGENT_TASK_ACCESS_DENIED/u);
    await expect(areas.execute(household, {
      action: "propose", id: secret.id, ownerRef: await spouseRef(), version: secret.version,
    })).rejects.toThrow(/AGENT_TASK_ACCESS_DENIED/u);
    await database().query("UPDATE space_memberships SET role='child' WHERE space_id=$1 AND user_id=$2",
      [fixture.pairSpaceId, fixture.owner.userId]);
    const updated = await authorization(fixture.owner, fixture.householdSpaceId, "private");
    await expect(areas.execute(updated, { action: "retire", id: first.id, version: first.version }))
      .rejects.toThrow(/AGENT_SPACE_ACCESS_DENIED/u);
  });

  it("allows clarification of an unassigned task, but only the assignee after claiming", async () => {
    const task = (await sharedTaskRepository.execute(auth(fixture.owner),
      { action: "create", title: "Разобраться", unassigned: true }, "unassigned")).task!;
    const clarified = (await sharedTaskRepository.execute(auth(fixture.spouse),
      { action: "update", id: task.id, version: task.version, title: "Записаться на ТО" }, "clarify")).task!;
    expect(clarified.title).toBe("Записаться на ТО");
    await sharedTaskRepository.execute(auth(fixture.owner),
      { action: "plan", id: task.id, plannedFrom: "2026-09-14", plannedUntil: "2026-09-20" }, "plan-open");
    const claimed = (await sharedTaskRepository.execute(auth(fixture.spouse),
      { action: "claim", id: task.id }, "claim-open")).task!;
    await expect(sharedTaskRepository.execute(auth(fixture.owner),
      { action: "update", id: task.id, version: claimed.version, title: "Другое" }, "rewrite"))
      .rejects.toThrow(/AGENT_TASK_ACCESS_DENIED/u);
  });

  it("gives an area an owner only when that person says yes", async () => {
    const created = (await areas.execute(auth(fixture.owner), { action: "create", title: "Машина" })).area!;
    expect(created).toMatchObject({ owner: null, pendingOwner: null, status: "open" });

    const proposed = (await areas.execute(auth(fixture.owner),
      { action: "propose", id: created.id, ownerRef: await spouseRef(), version: created.version })).area!;
    // Предложение ничего не меняет, кроме видимого ожидания: хозяина у области ещё нет.
    expect(proposed).toMatchObject({ owner: null, pendingOwner: "Супруга", status: "proposed" });

    // Принять может только тот, кому предложили.
    await expect(areas.execute(auth(fixture.owner),
      { action: "accept", id: created.id, version: proposed.version }))
      .rejects.toThrow(/AGENT_TASK_ACCESS_DENIED/u);
    const accepted = (await areas.execute(auth(fixture.spouse),
      { action: "accept", id: created.id, version: proposed.version })).area!;
    expect(accepted).toMatchObject({ owner: "Супруга", pendingOwner: null, status: "accepted" });
  });

  it("keeps the current owner responsible until a handover is accepted", async () => {
    // «До согласия отвечаю я»: раньше предложение сразу снимало хозяина, и отказ оставлял область
    // вообще без ответственного.
    const created = (await areas.execute(auth(fixture.owner), { action: "create", title: "Документы" })).area!;
    const offered = (await areas.execute(auth(fixture.owner),
      { action: "propose", id: created.id, ownerRef: await spouseRef(), version: created.version })).area!;
    const taken = (await areas.execute(auth(fixture.spouse),
      { action: "accept", id: created.id, version: offered.version })).area!;

    const handover = (await areas.execute(auth(fixture.spouse),
      { action: "propose", id: created.id, ownerRef: await ownerRef(), version: taken.version })).area!;
    expect(handover).toMatchObject({ owner: "Супруга", pendingOwner: "Владелец", status: "proposed" });

    const declined = (await areas.execute(auth(fixture.owner),
      { action: "decline", id: created.id, version: handover.version })).area!;
    expect(declined).toMatchObject({ owner: "Супруга", pendingOwner: null, status: "accepted" });
  });

  it("returns a released area to nobody instead of handing it on", async () => {
    const created = (await areas.execute(auth(fixture.owner), { action: "create", title: "Садик" })).area!;
    const proposed = (await areas.execute(auth(fixture.owner),
      { action: "propose", id: created.id, ownerRef: await spouseRef(), version: created.version })).area!;
    const accepted = (await areas.execute(auth(fixture.spouse),
      { action: "accept", id: created.id, version: proposed.version })).area!;

    // Отказаться вести может только хозяин, и никто не назначается вместо него.
    await expect(areas.execute(auth(fixture.owner),
      { action: "release", id: created.id, version: accepted.version }))
      .rejects.toThrow(/AGENT_TASK_ACCESS_DENIED/u);
    const released = (await areas.execute(auth(fixture.spouse),
      { action: "release", id: created.id, version: accepted.version })).area!;
    expect(released).toMatchObject({ owner: null, status: "open" });
    expect((await areas.execute(auth(fixture.owner), { action: "list" })).areas)
      .toEqual([expect.objectContaining({ status: "open", title: "Садик" })]);
  });

  it("offers a task of an accepted area to the person who took it", async () => {
    const created = (await areas.execute(auth(fixture.owner), { action: "create", title: "Машина" })).area!;
    const proposed = (await areas.execute(auth(fixture.owner),
      { action: "propose", id: created.id, ownerRef: await spouseRef(), version: created.version })).area!;
    await areas.execute(auth(fixture.spouse), { action: "accept", id: created.id, version: proposed.version });

    const task = (await sharedTaskRepository.execute(auth(fixture.owner),
      { action: "create", careAreaRef: created.id, title: "Записать на ТО" }, "care-task")).task!;
    // Не назначение, а следствие принятой области: получатель всё равно принимает дело сам.
    expect(task).toMatchObject({ assignee: "Супруга", status: "proposed", careAreaRef: created.id });
    await sharedTaskRepository.execute(auth(fixture.owner),
      { action: "create", title: "Без области заботы" }, "no-care-task");
    const filtered = await sharedTaskRepository.execute(auth(fixture.owner),
      { action: "list", careAreaRef: created.id }, "filter-care");
    expect(filtered.tasks!.map(item => item.id)).toEqual([task.id]);
    const stored = await database().query<{ care_area_id: string }>(
      "SELECT care_area_id FROM shared_tasks WHERE id=$1", [task.id]);
    expect(stored.rows[0]).toMatchObject({ care_area_id: created.id });
  });

  it("refuses a stale version and a second area of the same name", async () => {
    const created = (await areas.execute(auth(fixture.owner), { action: "create", title: "Машина" })).area!;
    await areas.execute(auth(fixture.owner),
      { action: "propose", id: created.id, ownerRef: await spouseRef(), version: created.version });
    await expect(areas.execute(auth(fixture.owner),
      { action: "propose", id: created.id, ownerRef: await spouseRef(), version: created.version }))
      .rejects.toThrow(/AGENT_CARE_AREA_STALE/u);
    await expect(areas.execute(auth(fixture.owner), { action: "create", title: "машина" }))
      .rejects.toThrow(/AGENT_CARE_AREA_DUPLICATE/u);
  });
});
