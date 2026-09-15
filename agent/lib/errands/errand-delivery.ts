/** Durable single-attempt delivery. An uncertain POST is never retried. */
import { database } from "../database.js";
import { initiativeRepository } from "../initiative/initiative-repository.js";
import { decideInitiative } from "../initiative/initiative-policy.js";
import { deliverErrandResult } from "./errand-result-delivery.js";
import { authorizeRecordSpaceAction } from "../spaces/space-access.js";
import type { ErrandRow } from "./errand-records.js";
import type { ErrandState } from "./errand-contract.js";
import { AppError } from "../app-error.js";

interface Outcome { state: ErrandState; delivered: boolean | null; reason?: string }
const outcome = (state: ErrandState, reason?: string): Outcome => ({ state,
  delivered: state === "sent" ? true : state === "sending" || state === "ambiguous" ? null : false,
  ...(reason ? { reason } : {}) });

export function createErrandDelivery(dependencies = { send: deliverErrandResult }) {
  return async (id: string, now = new Date()): Promise<Outcome> => {
    const client = await database().connect();
    let row: ErrandRow;
    let chatId: string;
    let text: string;
    try {
      await client.query("BEGIN");
      // Same lock order for opposing A->B and B->A errands: quota locks precede record locks.
      const candidate = (await client.query<ErrandRow>("SELECT * FROM errands WHERE id=$1", [id])).rows[0];
      if (!candidate) { await client.query("COMMIT"); return outcome("failed", "unavailable"); }
      let originAllowed = true;
      // Parent boundary comes before identities and the mutable errand row.
      if (candidate.space_id) {
        try {
          await authorizeRecordSpaceAction(client, { familyId: candidate.family_id,
            userId: candidate.initiator_user_id, spaceId: candidate.space_id, chat: { type: "private" } }, "write");
        } catch (error) {
          if (!(error instanceof AppError) || error.code !== "AGENT_SPACE_ACCESS_DENIED") throw error;
          originAllowed = false;
        }
      }
      await client.query("SELECT id FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
        [[candidate.initiator_user_id, candidate.recipient_user_id]]);
      row = (await client.query<ErrandRow>("SELECT * FROM errands WHERE id=$1 FOR UPDATE", [id])).rows[0]!;
      if (row.state !== "queued") { await client.query("COMMIT"); return outcome(row.state, row.diagnostic_code ?? undefined); }
      const reject = async (reason: string) => {
        await client.query("UPDATE errands SET state='failed',diagnostic_code=$2,version=version+1,updated_at=$3 WHERE id=$1",
          [id, reason, now]);
        await client.query("COMMIT");
        return outcome("failed", reason);
      };
      const members = await client.query(`SELECT user_id FROM family_memberships
        WHERE family_id=$1 AND user_id=ANY($2::uuid[]) FOR SHARE`,
      [row.family_id, [row.initiator_user_id, row.recipient_user_id]]);
      if (members.rowCount !== 2 || !row.delivery_authorized || !originAllowed || row.space_id !== candidate.space_id)
        return await reject("access_revoked");
      const route = (await client.query<{ telegram_chat_id: string }>(`SELECT c.telegram_chat_id
        FROM application_conversations c JOIN users u ON u.id=c.owner_user_id
        WHERE c.family_id=$1 AND c.owner_user_id=$2 AND c.scope='personal'
          AND c.telegram_group_id IS NULL AND c.telegram_chat_id=u.telegram_user_id`,
      [row.family_id, row.recipient_user_id])).rows[0];
      if (!route) return await reject("recipient_unavailable");
      chatId = route.telegram_chat_id;
      const policy = await initiativeRepository.read(row.recipient_user_id, now, client);
      if (!policy) return await reject("recipient_unavailable");
      const decision = decideInitiative(policy.settings, policy.state, now);
      if (!decision.allowed) {
        if (decision.reason === "muted") return await reject("muted");
        await client.query("COMMIT");
        return outcome("queued", decision.reason);
      }
      const result = (await client.query<{ text: string; sources: { url: string; checkedAt: string }[] }>(
        "SELECT text,sources FROM errand_results WHERE errand_id=$1 AND result_version=$2", [id, row.result_version])).rows[0]!;
      text = `${result.text}${result.sources.length ? "\n\nИсточники:\n" + result.sources.map(source =>
        `${source.url} (проверено ${source.checkedAt})`).join("\n") : ""}\n\nЭто подборка по поручению участника семьи. Ответ останется в вашем личном чате, пока вы явно не попросите передать его.`;
      await client.query(`INSERT INTO errand_deliveries(errand_id,result_version,state,started_at)
        VALUES($1,$2,'sending',$3)`, [id, row.result_version, now]);
      await client.query("UPDATE errands SET state='sending',version=version+1,updated_at=$2 WHERE id=$1", [id, now]);
      await client.query(`INSERT INTO initiative_messages(family_id,user_id,kind,sent_on,sent_at)
        VALUES($1,$2,'errand',($3::timestamptz AT TIME ZONE $4)::date,$3)`,
      [row.family_id, row.recipient_user_id, now, policy.settings.timezone]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }

    let messageId: string | null = null;
    try {
      const confirmed = await dependencies.send({ chatId, text });
      if (/^[1-9]\d*$/u.test(confirmed)) messageId = confirmed;
    } catch { /* The network outcome is unknown; keep the ledger terminal. */ }
    const state = messageId ? "sent" : "ambiguous";
    const settled = await database().connect();
    try {
      await settled.query("BEGIN");
      await settled.query("SELECT id FROM errands WHERE id=$1 FOR UPDATE", [id]);
      await settled.query(`UPDATE errand_deliveries SET state=$3,telegram_message_id=$4,
        diagnostic_code=$5,completed_at=now() WHERE errand_id=$1 AND result_version=$2 AND state IN ('sending','ambiguous')`,
      [id, row.result_version, state, messageId, messageId ? null : "delivery_ambiguous"]);
      await settled.query(`UPDATE errands SET state=$2,diagnostic_code=$3,version=version+1,updated_at=now()
        WHERE id=$1 AND state IN ('sending','ambiguous')`, [id, state, messageId ? null : "delivery_ambiguous"]);
      await settled.query("COMMIT");
    } catch (error) { await settled.query("ROLLBACK"); throw error; }
    finally { settled.release(); }
    return outcome(state);
  };
}
