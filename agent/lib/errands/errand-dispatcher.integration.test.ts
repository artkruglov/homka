/** Crash recovery must close uncertainty, never repeat an already claimed network attempt. */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { database, closeDatabase } from "../database.js";
import { createTwoSpaceFixture } from "../spaces/two-space-fixture.js";
import { createErrandDispatcher } from "./errand-dispatcher.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("AGENT_TEST_DATABASE_UNSAFE");
const now = new Date("2026-09-13T09:00:00Z");
let id: string;
(enabled ? describe : describe.skip)("errand dispatcher recovery", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE families,users CASCADE");
    const f = await createTwoSpaceFixture("errand-dispatch");
    id = (await database().query(`INSERT INTO errands(family_id,initiator_user_id,recipient_user_id,
      private_query,brief,delivery_authorized,state,result_version)
      VALUES($1,$2,$3,'private','public',true,'sending',1) RETURNING id`,
    [f.familyId,f.owner.userId,f.spouse.userId])).rows[0].id;
    await database().query("INSERT INTO errand_results(errand_id,result_version,text,sources) VALUES($1,1,'result','[]')", [id]);
    await database().query(`INSERT INTO errand_deliveries(errand_id,result_version,state,started_at)
      VALUES($1,1,'sending',$2::timestamptz-interval '3 minutes')`, [id,now]);
  });
  afterAll(closeDatabase);
  it("retires a crashed send as ambiguous without retry, and leaves recent claims alone", async () => {
    const deliver = vi.fn();
    const dispatch = createErrandDispatcher({ deliver });
    await database().query("UPDATE errand_deliveries SET started_at=$2 WHERE errand_id=$1", [id,now]);
    await dispatch(now);
    expect((await database().query("SELECT state FROM errands WHERE id=$1", [id])).rows[0].state).toBe("sending");
    await dispatch(new Date(now.getTime()+180_000));
    expect((await database().query("SELECT state FROM errands WHERE id=$1", [id])).rows[0].state).toBe("ambiguous");
    expect((await database().query("SELECT state,diagnostic_code FROM errand_deliveries WHERE errand_id=$1", [id])).rows[0])
      .toMatchObject({state:"ambiguous",diagnostic_code:"delivery_interrupted"});
    await dispatch(new Date(now.getTime()+360_000));
    expect(deliver).not.toHaveBeenCalled();
  });
});
