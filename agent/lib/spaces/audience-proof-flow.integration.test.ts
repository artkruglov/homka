/**
 * Поимённая проверка говорит, что названные люди в чате есть. То, что в нём нет никого больше,
 * говорит только счётчик, поэтому замыкание проверяется отдельно и блокирует подтверждение.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

import { closeDatabase, database } from "../database.js";
import { commitAudienceProof, planAudienceProof } from "./audience-proof-flow.js";
import { isAudienceProven } from "./telegram-audience-proof.js";
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

function telegram(options: { count: number | null; statuses?: Record<string, string> }) {
  return {
    memberCount: vi.fn().mockResolvedValue(options.count),
    memberStatus: vi.fn().mockImplementation(async (_chat: string, userId: string) =>
      options.statuses?.[userId] ?? "member"),
    selfId: vi.fn().mockResolvedValue("777"),
  };
}

async function transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

dbDescribe("audience proof flow", () => {
  let fixture: TwoSpaceFixture;

  beforeEach(async () => {
    await database().query(
      "TRUNCATE spaces, telegram_groups, family_memberships, users, families CASCADE",
    );
    fixture = await createTwoSpaceFixture("audience-flow");
    // Доказательство собирают для чата, состав которого ещё не подтверждён.
    await database().query(
      "UPDATE space_bindings SET state='pending_verification' WHERE group_id=$1", [fixture.groupId],
    );
  });
  afterAll(closeDatabase);

  it("proves the roster, closes it with the count and activates the binding", async () => {
    const api = telegram({ count: 3, statuses: { 777: "administrator" } });
    const plan = await transaction((client) => planAudienceProof(client, api, {
      declaredBotCount: 1, telegramChatId: fixture.telegramChatId,
    }));

    expect(plan.blockers).toEqual([]);
    expect(plan.members.map((member) => member.present)).toEqual([true, true]);
    await transaction((client) => commitAudienceProof(client, plan, fixture.owner.userId));

    const binding = await database().query<{ state: string }>(
      "SELECT state FROM space_bindings WHERE group_id=$1", [fixture.groupId],
    );
    expect(binding.rows[0]!.state).toBe("active");
    const policyVersion = await currentSpacePolicyVersion(fixture.pairSpaceId);
    await expect(transaction((client) => isAudienceProven(client, {
      groupId: fixture.groupId,
      now: new Date(),
      policyVersion,
      spaceId: fixture.pairSpaceId,
    }))).resolves.toBe(true);
  });

  it("refuses to confirm a chat with one more participant than the roster explains", async () => {
    const api = telegram({ count: 4, statuses: { 777: "administrator" } });
    const plan = await transaction((client) => planAudienceProof(client, api, {
      declaredBotCount: 1, telegramChatId: fixture.telegramChatId,
    }));

    expect(plan.blockers).toContain("AGENT_SPACE_AUDIENCE_NOT_CLOSED");
    await expect(transaction((client) => commitAudienceProof(client, plan, fixture.owner.userId)))
      .rejects.toThrowError(/AGENT_SPACE_AUDIENCE_NOT_PROVABLE/);
  });

  it("does not confirm a chat where the bot is not an administrator", async () => {
    const api = telegram({ count: 3 });
    const plan = await transaction((client) => planAudienceProof(client, api, {
      declaredBotCount: 1, telegramChatId: fixture.telegramChatId,
    }));

    expect(plan.blockers).toContain("AGENT_SPACE_AUDIENCE_BOT_NOT_ADMINISTRATOR");
  });

  it("counts an absent member out of the roster and lets the count close without them", async () => {
    const api = telegram({
      count: 2, statuses: { 777: "administrator", [fixture.spouse.telegramUserId]: "left" },
    });
    const plan = await transaction((client) => planAudienceProof(client, api, {
      declaredBotCount: 1, telegramChatId: fixture.telegramChatId,
    }));

    expect(plan.blockers).toEqual([]);
    await transaction((client) => commitAudienceProof(client, plan, fixture.owner.userId));
    const stored = await database().query<{ roster: string[] }>(
      "SELECT roster FROM telegram_chat_audience_proofs WHERE group_id=$1", [fixture.groupId],
    );
    expect(stored.rows[0]!.roster).toEqual([fixture.owner.userId]);
  });

  it("refuses a confirmation that does not come from the owner", async () => {
    const api = telegram({ count: 3, statuses: { 777: "administrator" } });
    const plan = await transaction((client) => planAudienceProof(client, api, {
      declaredBotCount: 1, telegramChatId: fixture.telegramChatId,
    }));

    await expect(transaction((client) => commitAudienceProof(client, plan, fixture.spouse.userId)))
      .rejects.toThrowError(/AGENT_SPACE_AUDIENCE_CONFIRMER_INVALID/);
  });
  it("resumes only jobs paused by this migration after confirmed audience", async () => {
    const f=fixture;
    await database().query(`INSERT INTO telegram_group_migrations(family_id,group_id,old_chat_id,new_chat_id,source_update_id)
      VALUES($1,$2,'-999999999',$3,8001)`,[f.familyId,f.groupId,f.telegramChatId]);
    for(const reason of ['AGENT_TELEGRAM_GROUP_MIGRATED','manual-pause']) {
      await database().query(`INSERT INTO reminders(family_id,author_user_id,group_id,scope,content,timezone,
        telegram_chat_id,recurrence_anchor_local,due_at,available_at,status,last_error_code)
        VALUES($1,$2,$3,'family',$4,'UTC',$5,now(),now()-interval '1 hour',now(),'paused',$4)`,
        [f.familyId,f.owner.userId,f.groupId,reason,f.telegramChatId]);
      await database().query(`INSERT INTO agent_schedules(family_id,author_user_id,group_id,scope,title,user_request,scenario_prompt,
        timezone,recurrence_kind,recurrence_interval,recurrence_anchor_local,next_run_at,telegram_chat_id,telegram_chat_type,status,last_error_code)
        VALUES($1,$2,$3,'family',$4,'Request','Scenario','UTC','once',1,now(),now(),$5,'supergroup','paused',$4)`,
        [f.familyId,f.owner.userId,f.groupId,reason,f.telegramChatId]);
    }
    const api=telegram({count:3,statuses:{777:'administrator'}});
    const plan=await transaction(client=>planAudienceProof(client,api,{declaredBotCount:1,telegramChatId:f.telegramChatId}));
    await transaction(client=>commitAudienceProof(client,plan,f.owner.userId));
    await transaction(client=>commitAudienceProof(client,plan,f.owner.userId));
    for(const table of ['reminders','agent_schedules']){
      expect((await database().query(`SELECT status,last_error_code FROM ${table} ORDER BY status`)).rows)
        .toEqual([{status:'active',last_error_code:null},{status:'paused',last_error_code:'manual-pause'}]);
    }
    expect((await database().query("SELECT count(*)::int n FROM audit_events WHERE event_type='telegram.group_migration_jobs_resumed'")).rows[0].n).toBe(1);
  });

});
