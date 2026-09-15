/** Dispatch authorized results, and close abandoned attempts without replaying Telegram POSTs. */
import { database } from "../database.js";
import { createErrandDelivery } from "./errand-delivery.js";

export function createErrandDispatcher(dependencies = { deliver: createErrandDelivery() }) {
  return async (now = new Date()): Promise<void> => {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      // Lock order matches settlement: the errand before its delivery ledger.
      const abandoned = (await client.query<{ id: string; result_version: number }>(
        `SELECT e.id,e.result_version FROM errands e JOIN errand_deliveries d
          ON d.errand_id=e.id AND d.result_version=e.result_version
          WHERE e.state='sending' AND d.state='sending' AND d.started_at<$1::timestamptz-interval '2 minutes'
          ORDER BY d.started_at,e.id LIMIT 100 FOR UPDATE OF e SKIP LOCKED`, [now])).rows;
      for (const row of abandoned) {
        await client.query(`UPDATE errand_deliveries SET state='ambiguous',diagnostic_code='delivery_interrupted',
          completed_at=$3 WHERE errand_id=$1 AND result_version=$2 AND state='sending'`, [row.id,row.result_version,now]);
        await client.query(`UPDATE errands SET state='ambiguous',diagnostic_code='delivery_interrupted',
          updated_at=$2,version=version+1 WHERE id=$1`, [row.id,now]);
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }

    const queued = (await database().query<{ id: string }>(
      "SELECT id FROM errands WHERE state='queued' ORDER BY updated_at,id LIMIT 50")).rows;
    for (let index=0; index<queued.length; index+=4) {
      await Promise.all(queued.slice(index,index+4).map(async row => {
        try {
          // Move deferred entries to the back so a quiet household cannot starve other recipients.
          await database().query("UPDATE errands SET updated_at=$2 WHERE id=$1 AND state='queued'", [row.id,now]);
          await dependencies.deliver(row.id,now);
        } catch {
          console.error(JSON.stringify({code:"AGENT_ERRAND_DISPATCH_FAILED",errandId:row.id}));
        }
      }));
    }
  };
}

export const dispatchErrands = createErrandDispatcher();
