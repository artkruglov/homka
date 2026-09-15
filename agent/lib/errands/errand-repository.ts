/** Atomic intent and result changes. Delivery is a separate durable claim, never a tool retry. */
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { authorizeRecordSpaceAction } from "../spaces/space-access.js";
import { readFamilySpaceMode } from "../spaces/family-space-mode.js";
import { errandInput, nextErrandState, type ErrandInput } from "./errand-contract.js";
import { authorizeErrandActor, listErrandRecipients, resolveErrandRecipient } from "./errand-recipients.js";
import { errandDenied, presentErrand, readErrand, type ErrandView } from "./errand-records.js";

/** Supplied by verified tool context, not by fields of model input. */
export interface ErrandInvocation {
  operationKey: string; sessionId: string; turnId: string; privateQuery: string;
}
interface ErrandResponse {
  errand?: ErrandView; errands?: ErrandView[];
  recipients?: { name: string; recipientRef: string }[]; replayed?: boolean;
}

async function personalOrigin(client: PoolClient, auth: MemoryAuthorization): Promise<string | null> {
  // A private instruction remains personal even when its author selected a shared workspace.
  const row = (await client.query<{ id: string }>(
    "SELECT id FROM spaces WHERE family_id=$1 AND owner_user_id=$2 AND kind='personal' AND state='active' FOR SHARE",
    [auth.familyId, auth.userId],
  )).rows[0];
  if (!row) {
    if (await readFamilySpaceMode(client, auth.familyId) === "spaces") {
      throw new AppError("AGENT_ERRAND_PERSONAL_SPACE_REQUIRED", "Личное пространство ещё не подготовлено");
    }
    return null;
  }
  await authorizeRecordSpaceAction(client, { familyId: auth.familyId, userId: auth.userId,
    spaceId: row.id, chat: { type: "private" } }, "write");
  return row.id;
}

export const errandRepository = {
  async execute(auth: MemoryAuthorization, raw: ErrandInput, invocation: ErrandInvocation): Promise<ErrandResponse> {
    const parsed = errandInput.safeParse(raw);
    if (!parsed.success) throw new AppError("AGENT_ERRAND_INPUT_INVALID", "Проверьте действие и поля поручения");
    const input = parsed.data;
    if (input.action === "recipients") return { recipients: await listErrandRecipients(auth) };
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const origin = input.action === "create" ? await personalOrigin(client, auth) : null;
      const actor = await authorizeErrandActor(client, auth);
      if (input.action === "list") {
        const ids = (await client.query<{ id: string }>(
          `SELECT e.id FROM errands e WHERE e.family_id=$1 AND (
            ($3::text='sent' AND e.initiator_user_id=$2) OR
            ($3::text='received' AND e.recipient_user_id=$2 AND EXISTS (
              SELECT 1 FROM errand_deliveries d WHERE d.errand_id=e.id AND d.result_version=e.result_version
                AND d.state IN ('sending','sent','ambiguous'))))
            ORDER BY e.created_at DESC,e.id DESC LIMIT 20`,
          [auth.familyId, actor, input.view ?? "sent"],
        )).rows;
        const errands: ErrandView[] = [];
        for (const { id } of ids) errands.push(await presentErrand(client, await readErrand(client, auth.familyId, actor, id), actor));
        await client.query("COMMIT");
        return { errands };
      }
      if (input.action === "get") {
        const errand = await presentErrand(client, await readErrand(client, auth.familyId, actor, input.id!), actor);
        await client.query("COMMIT");
        return { errand };
      }
      if (!invocation.operationKey || invocation.operationKey.length > 500 || !invocation.sessionId || !invocation.turnId) {
        throw new AppError("AGENT_ERRAND_PROVENANCE_REQUIRED", "Не удалось подтвердить исходный вызов поручения");
      }
      const hash = createHash("sha256").update(JSON.stringify({ input, actor,
        sessionId: invocation.sessionId, turnId: invocation.turnId })).digest("hex");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`${auth.familyId}:errand:${invocation.operationKey}`]);
      const previous = (await client.query<{ errand_id: string; request_hash: string }>(
        "SELECT errand_id,request_hash FROM errand_operations WHERE family_id=$1 AND operation_key=$2",
        [auth.familyId, invocation.operationKey],
      )).rows[0];
      if (previous) {
        if (previous.request_hash !== hash) throw new AppError("AGENT_ERRAND_OPERATION_CONFLICT", "Этот вызов уже относится к другому поручению");
        const errand = await presentErrand(client, await readErrand(client, auth.familyId, actor, previous.errand_id), actor);
        await client.query("COMMIT");
        return { errand, replayed: true };
      }
      let id: string;
      if (input.action === "create") {
        if (!invocation.privateQuery.trim() || invocation.privateQuery.length > 12000) {
          throw new AppError("AGENT_ERRAND_SOURCE_REQUIRED", "Нужен исходный запрос человека");
        }
        const recipient = await resolveErrandRecipient(client, auth, input.recipientRef!);
        id = (await client.query<{ id: string }>(
          `INSERT INTO errands(family_id,initiator_user_id,recipient_user_id,space_id,private_query,brief,delivery_authorized)
            VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [auth.familyId, actor, recipient.userId, origin, invocation.privateQuery, input.brief, input.mode === "send"],
        )).rows[0]!.id;
      } else {
        const row = await readErrand(client, auth.familyId, actor, input.id!, true);
        id = row.id;
        if (input.action === "share_answer") {
          if (row.recipient_user_id !== actor || input.resultVersion !== row.result_version) errandDenied();
          await client.query("INSERT INTO errand_answers(errand_id,result_version,text) VALUES($1,$2,$3)",
            [id, input.resultVersion, input.text]);
        } else {
          if (row.initiator_user_id !== actor) errandDenied();
          if (input.version !== undefined && input.version !== row.version) {
            throw new AppError("AGENT_ERRAND_VERSION_CONFLICT", "Поручение уже изменилось. Прочитайте его заново");
          }
          const state = row.state === "cancelled" && input.action === "cancel" ? "cancelled"
            : nextErrandState(row.state, input.action, row.delivery_authorized);
          let resultVersion = row.result_version;
          if (input.action === "result") {
            resultVersion += 1;
            await client.query("INSERT INTO errand_results(errand_id,result_version,text,sources) VALUES($1,$2,$3,$4)",
              [id, resultVersion, input.text, JSON.stringify(input.sources)]);
          }
          await client.query(`UPDATE errands SET state=$2,result_version=$3,version=version+1,
            delivery_authorized=delivery_authorized OR $4,updated_at=now() WHERE id=$1`,
            [id, state, resultVersion, input.action === "send"]);
        }
      }
      await client.query(`INSERT INTO errand_operations
        (family_id,errand_id,operation_key,request_hash,actor_user_id,eve_session_id,eve_turn_id,action)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [auth.familyId, id, invocation.operationKey, hash, actor, invocation.sessionId, invocation.turnId, input.action]);
      const errand = await presentErrand(client, await readErrand(client, auth.familyId, actor, id), actor);
      await client.query("COMMIT");
      return { errand, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  },
};
