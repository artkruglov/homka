/** Durable research claim and cached result; no root-authored result crosses this boundary. */
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { errandResearchResult } from "./errand-contract.js";
import { authorizeErrandActor } from "./errand-recipients.js";
import { readErrand, errandDenied } from "./errand-records.js";
import { errandRepository, type ErrandInvocation } from "./errand-repository.js";

interface ResearchRun {
  state: "started" | "completed" | "ambiguous";
  result: unknown;
  eve_session_id: string;
  eve_turn_id: string;
}

export function createErrandResearchService(research: (brief: string) => Promise<unknown>) {
  return async (auth: MemoryAuthorization, input: {id:string;version:number}, invocation: ErrandInvocation) => {
    const client = await database().connect();
    let brief = "";
    let run: ResearchRun;
    let fresh = false;
    try {
      await client.query("BEGIN");
      const actor = await authorizeErrandActor(client, auth);
      const errand = await readErrand(client, auth.familyId, actor, input.id, true);
      if (errand.initiator_user_id !== actor) errandDenied();
      const previous = (await client.query<ResearchRun>(
        "SELECT state,result,eve_session_id,eve_turn_id FROM errand_research_runs WHERE errand_id=$1 AND input_version=$2",
        [input.id,input.version])).rows[0];
      if (previous) {
        if (previous.state !== "completed") throw new AppError("AGENT_ERRAND_RESEARCH_UNCERTAIN",
          "Исследование уже началось, но готовый результат не сохранён. Не повторяйте оплачиваемый запрос автоматически");
        run = previous;
      } else {
        if (errand.version !== input.version || errand.state !== "preparing") {
          throw new AppError("AGENT_ERRAND_VERSION_CONFLICT", "Прочитайте актуальное состояние поручения");
        }
        if (!invocation.sessionId || !invocation.turnId) throw new Error("AGENT_ERRAND_PROVENANCE_REQUIRED");
        await client.query(`INSERT INTO errand_research_runs(errand_id,input_version,state,eve_session_id,eve_turn_id)
          VALUES($1,$2,'started',$3,$4)`, [input.id,input.version,invocation.sessionId,invocation.turnId]);
        brief = errand.brief;
        run = {state:"started",result:null,eve_session_id:invocation.sessionId,eve_turn_id:invocation.turnId};
        fresh = true;
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }

    if (fresh) {
      try {
        const result = errandResearchResult.parse(await research(brief));
        // Persist before the live reauthorization/queue transaction: recovery can reuse these bytes.
        await database().query(`UPDATE errand_research_runs SET state='completed',result=$3,completed_at=now()
          WHERE errand_id=$1 AND input_version=$2 AND state='started'`,
          [input.id,input.version,JSON.stringify(result)]);
        run.result = result;
      } catch (error) {
        await database().query(`UPDATE errand_research_runs SET state='ambiguous',completed_at=now()
          WHERE errand_id=$1 AND input_version=$2 AND state='started'`,[input.id,input.version]);
        throw new AppError("AGENT_ERRAND_RESEARCH_UNCERTAIN", "Исследование не дало сохранённого результата. Автоматического повтора не будет");
      }
    }
    const result = errandResearchResult.parse(run.result);
    return errandRepository.execute(auth, {action:"result",id:input.id,version:input.version,...result}, {
      operationKey:`research:${input.id}:${input.version}`,
      sessionId:run.eve_session_id,turnId:run.eve_turn_id,privateQuery:"",
    });
  };
}
