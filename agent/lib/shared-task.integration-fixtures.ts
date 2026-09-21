/** One family with an owner, a member and a family group for planner story tests. */
import { randomUUID } from "node:crypto";
import { database } from "./database.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { sharedTaskRepository } from "./shared-task-repository.js";

export interface TaskFamilyFixture {
  owner: MemoryAuthorization;
  member: MemoryAuthorization;
  familyGroup: MemoryAuthorization;
}

export async function createTaskFamilyFixture(): Promise<TaskFamilyFixture> {
  await database().query("TRUNCATE families,users CASCADE");
  const family = (await database().query("INSERT INTO families(name) VALUES('Tasks') RETURNING id")).rows[0].id;
  const people = (await database().query(`INSERT INTO users(telegram_user_id,display_name)
    VALUES('700101','Owner'),('700102','Member') RETURNING id,telegram_user_id`)).rows;
  for (const person of people) {
    await database().query("INSERT INTO family_memberships(family_id,user_id,role) VALUES($1,$2,$3)",
      [family, person.id, person.telegram_user_id === "700101" ? "owner" : "member"]);
  }
  const auth = (who: string): MemoryAuthorization => ({ familyId: family, groupId: null, scopes: ["personal", "family"],
    role: who === "700101" ? "owner" : "member", userId: people.find((p) => p.telegram_user_id === who).id,
    telegramActorKind: "telegram_user", telegramActorId: who, telegramUserId: who });
  const owner = auth("700101");
  const groups = (await database().query(`INSERT INTO telegram_groups(family_id,telegram_chat_id,title,type,tool_allowlist,message_mode)
    VALUES($1,'-103','Family','family_private','{}','addressed_only') RETURNING id`, [family])).rows;
  return {
    owner,
    member: auth("700102"),
    familyGroup: { ...owner, groupId: groups[0].id, scopes: ["family"] },
  };
}

export async function makeTask(auth: MemoryAuthorization, title: string) {
  return (await sharedTaskRepository.execute(auth, { action: "create", title }, randomUUID())).task!;
}
