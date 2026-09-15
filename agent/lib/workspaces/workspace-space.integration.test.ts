/**
 * Файлы принадлежат области так же, как записи памяти.
 *
 * Точка контроля для нативных `bash`, `read_file` и `write_file` в доверенном чате — набор
 * монтирований, а не обёртка инструмента: обёртки перекрывают встроенные инструменты Eve только
 * во внешних группах. Поэтому область обязана менять сам физический корень, а ход обязан видеть
 * ровно одну область: иначе `bash` в личке прочитает файлы соседней.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import {
  bindGroupToSpace,
  createTwoSpaceFixture,
  currentSpacePolicyVersion,
  type TwoSpaceFixture,
} from "../spaces/two-space-fixture.js";
import { createWorkspaceRepository } from "./workspace-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const dbDescribe = enabled ? describe : describe.skip;
const roots: string[] = [];

async function groupAuth(fixture: TwoSpaceFixture, spaceId: string | null) {
  return {
    familyId: fixture.familyId,
    groupId: fixture.groupId,
    groupType: "family_private" as const,
    role: "owner" as const,
    ...(spaceId === null
      ? {}
      : { space: { policyVersion: await currentSpacePolicyVersion(spaceId), spaceId } }),
    telegramChatType: "supergroup" as const,
    userId: fixture.owner.userId,
  };
}

async function privateAuth(fixture: TwoSpaceFixture, spaceId: string | null) {
  return {
    familyId: fixture.familyId,
    groupId: null,
    groupType: null,
    role: "owner" as const,
    ...(spaceId === null
      ? {}
      : { space: { policyVersion: await currentSpacePolicyVersion(spaceId), spaceId } }),
    telegramChatType: "private" as const,
    userId: fixture.owner.userId,
  };
}

dbDescribe("workspace area", () => {
  let fixture: TwoSpaceFixture;
  let repository: ReturnType<typeof createWorkspaceRepository>;

  beforeEach(async () => {
    await database().query(
      `TRUNCATE workspaces, spaces, telegram_groups, family_memberships, users, families CASCADE`,
    );
    fixture = await createTwoSpaceFixture("workspace-space");
    await database().query(
      "UPDATE family_space_runtime SET mode='spaces', cutover_at=now(), reason='Переход' WHERE family_id=$1",
      [fixture.familyId],
    );
    const root = await mkdtemp(join(tmpdir(), "osinara-workspace-space-"));
    roots.push(root);
    repository = createWorkspaceRepository(root);
  });
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });
  afterAll(async () => closeDatabase());

  it("gives each area its own physical family root", async () => {
    const pair = await repository.mounts(await groupAuth(fixture, fixture.pairSpaceId));
    expect(pair).toEqual([{ mountPoint: "family", workspaceId: expect.any(String) }]);

    // Тот же чат, перепривязанный к другой области, получает другой корень: иначе `bash`
    // прочитал бы файлы прежней аудитории по тому же пути.
    await database().query("UPDATE space_bindings SET state='paused' WHERE group_id=$1", [fixture.groupId]);
    await database().query("DELETE FROM space_bindings WHERE group_id=$1", [fixture.groupId]);
    await bindGroupToSpace(database(), fixture.familyId, fixture.groupId, fixture.householdSpaceId);
    const household = await repository.mounts(await groupAuth(fixture, fixture.householdSpaceId));

    expect(household[0]!.workspaceId).not.toBe(pair[0]!.workspaceId);
  });

  it("mounts only the area the private turn proved", async () => {
    const personalSpace = (await database().query<{ id: string }>(
      `INSERT INTO spaces(family_id,kind,title,owner_user_id,state)
       VALUES($1,'personal','Личное',$2,'forming') RETURNING id`,
      [fixture.familyId, fixture.owner.userId],
    )).rows[0]!.id;
    await database().query(
      "INSERT INTO space_memberships(family_id,space_id,user_id,role,state) VALUES($1,$2,$3,'manager','active')",
      [fixture.familyId, personalSpace, fixture.owner.userId],
    );
    await database().query("UPDATE spaces SET state='active' WHERE id=$1", [personalSpace]);

    // Прежде личный чат монтировал и семейный корень: это вторая область в одном ходе.
    await expect(repository.mounts(await privateAuth(fixture, personalSpace)))
      .resolves.toEqual([{ mountPoint: "personal", workspaceId: expect.any(String) }]);
  });

  it("keeps legacy files reachable after their workspace was bound by migration", async () => {
    await database().query("UPDATE family_space_runtime SET mode='legacy', reason='rehearsal' WHERE family_id=$1", [fixture.familyId]);
    const auth = await groupAuth(fixture, null);
    const original = (await repository.mounts(auth))[0]!;
    const legacy = (await database().query<{ id: string }>(
      "INSERT INTO spaces(family_id,kind,title,legacy_scope) VALUES($1,'legacy_family','Прежнее','family') RETURNING id",
      [fixture.familyId],
    )).rows[0]!.id;
    await database().query("UPDATE workspaces SET space_id=$1 WHERE id=$2", [legacy, original.workspaceId]);

    expect(await repository.mounts(auth)).toEqual([original]);
    expect((await database().query("SELECT id FROM workspaces WHERE family_id=$1", [fixture.familyId])).rowCount).toBe(1);

    // A duplicate already in use may contain newer uploads. Repair must reconcile files,
    // not switch roots silently or delete either physical directory during ordinary reads.
    const duplicate = (await database().query<{ id: string }>(
      "INSERT INTO workspaces(family_id,scope) VALUES($1,'family') RETURNING id", [fixture.familyId],
    )).rows[0]!.id;
    expect(await repository.mounts(auth)).toEqual([{ mountPoint: "family", workspaceId: duplicate }]);
    expect((await database().query("SELECT id FROM workspaces WHERE family_id=$1", [fixture.familyId])).rowCount).toBe(2);

  });

  it("does not expose a newly created shared area as the legacy family root", async () => {
    const isolated = (await repository.mounts(await groupAuth(fixture, fixture.pairSpaceId)))[0]!;
    await database().query("UPDATE family_space_runtime SET mode='legacy', reason='rehearsal' WHERE family_id=$1", [fixture.familyId]);
    const legacy = (await repository.mounts(await groupAuth(fixture, null)))[0]!;
    expect(legacy.workspaceId).not.toBe(isolated.workspaceId);
  });

  it("refuses a turn without an area once the family switched", async () => {
    await expect(repository.mounts(await groupAuth(fixture, null)))
      .rejects.toThrowError(/AGENT_SPACE_CONTEXT_REQUIRED/);
  });
});
