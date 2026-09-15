/** Durable joint decisions; identity and audience come exclusively from verified authorization. */
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { decisionAudience } from "./decision-audience.js";
import { decisionInput,decisionStatus,type DecisionChoice,type DecisionInput } from "./joint-decision-contract.js";

interface Row {id:string;title:string;details:string|null;version:number;creator_user_id:string;partner_user_id:string;cancelled:boolean}
function denied():never {throw new AppError("AGENT_DECISION_ACCESS_DENIED","Решение недоступно вам в этой области");}

async function read(client:PoolClient,auth:MemoryAuthorization,spaceId:string|null,id:string,lock=false):Promise<Row>{
  const row=(await client.query<Row>(`SELECT * FROM joint_decisions WHERE id=$1 AND family_id=$2
    AND $3::uuid IN (creator_user_id,partner_user_id) AND space_id IS NOT DISTINCT FROM $4::uuid
    AND ($4::uuid IS NOT NULL OR group_id IS NOT DISTINCT FROM $5::uuid) ${lock?'FOR UPDATE':'FOR SHARE'}`,
  [id,auth.familyId,auth.userId,spaceId,auth.groupId])).rows[0];
  if(!row)denied();return row;
}
async function present(client:PoolClient,row:Row,actor:string){
  const answers=(await client.query<{actor_user_id:string;choice:DecisionChoice;name:string;updated_at:Date}>(
    `SELECT a.actor_user_id,a.choice,u.display_name AS name,a.updated_at FROM joint_decision_answers a
      JOIN users u ON u.id=a.actor_user_id WHERE a.decision_id=$1 ORDER BY a.actor_user_id`,[row.id])).rows;
  const feedback=(await client.query<{actor_user_id:string;text:string;name:string;updated_at:Date}>(
    `SELECT f.actor_user_id,f.text,u.display_name AS name,f.updated_at FROM joint_decision_feedback f
      JOIN users u ON u.id=f.actor_user_id WHERE f.decision_id=$1 ORDER BY f.actor_user_id`,[row.id])).rows;
  return {id:row.id,title:row.title,details:row.details,version:row.version,isProposer:row.creator_user_id===actor,
    status:decisionStatus([row.creator_user_id,row.partner_user_id],answers.map(a=>({actor:a.actor_user_id,choice:a.choice})),row.cancelled),
    answers:answers.map(a=>({name:a.name,choice:a.choice,isYou:a.actor_user_id===actor,answeredAt:a.updated_at.toISOString()})),
    feedback:feedback.map(f=>({name:f.name,text:f.text,isYou:f.actor_user_id===actor,updatedAt:f.updated_at.toISOString()}))};
}

export const jointDecisionRepository={
  async execute(auth:MemoryAuthorization,raw:DecisionInput,operationKey:string){
    const parsed=decisionInput.safeParse(raw);
    if(!parsed.success)throw new AppError("AGENT_DECISION_INPUT_INVALID","Проверьте действие и поля решения");
    const input=parsed.data,client=await database().connect();
    try{
      await client.query("BEGIN");
      // Replies and voluntary feedback need read access; only creating a shared proposal needs write.
      const audience=await decisionAudience(client,auth,input.action==='create');
      const actor=auth.userId!;
      if(input.action==='participants'){await client.query("COMMIT");return {participants:audience.participants};}
      if(input.action==='list'){
        const rows=(await client.query<Row>(`SELECT * FROM joint_decisions WHERE family_id=$1
          AND $2::uuid IN (creator_user_id,partner_user_id) AND space_id IS NOT DISTINCT FROM $3::uuid
          AND ($3::uuid IS NOT NULL OR group_id IS NOT DISTINCT FROM $4::uuid)
          ORDER BY created_at DESC,id DESC LIMIT 51 FOR SHARE`,[auth.familyId,actor,audience.spaceId,auth.groupId])).rows;
        const decisions=[];
        for(const row of rows.slice(0,50))decisions.push(await present(client,row,actor));
        await client.query("COMMIT");return {decisions,truncated:rows.length>50};
      }
      if(input.action==='get'){
        const decision=await present(client,await read(client,auth,audience.spaceId,input.id!),actor);
        await client.query("COMMIT");return {decision};
      }
      if(!operationKey||operationKey.length>500)denied();
      const hash=createHash('sha256').update(JSON.stringify({input,actor,spaceId:audience.spaceId,groupId:auth.groupId})).digest('hex');
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`decision:${auth.familyId}:${operationKey}`]);
      const previous=(await client.query<{decision_id:string;request_hash:string}>(
        "SELECT decision_id,request_hash FROM joint_decision_operations WHERE family_id=$1 AND operation_key=$2",[auth.familyId,operationKey])).rows[0];
      if(previous){
        if(previous.request_hash!==hash)denied();
        const decision=await present(client,await read(client,auth,audience.spaceId,previous.decision_id),actor);
        await client.query("COMMIT");return {decision,replayed:true};
      }
      let id:string;
      if(input.action==='create'){
        if(!audience.participants.some(p=>p.participantRef===input.partnerRef))denied();
        const partner=(await client.query<{id:string}>(`SELECT u.id FROM shared_task_participants p
          JOIN users u ON u.telegram_user_id=p.telegram_user_id
          JOIN family_memberships m ON m.user_id=u.id AND m.family_id=p.family_id
          WHERE p.id=$1 AND p.family_id=$2 AND p.group_id IS NULL FOR SHARE OF m,u`,[input.partnerRef,auth.familyId])).rows[0];
        if(!partner||partner.id===actor)denied();
        id=(await client.query<{id:string}>(`INSERT INTO joint_decisions(family_id,creator_user_id,partner_user_id,space_id,group_id,title,details)
          VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,[auth.familyId,actor,partner.id,audience.spaceId,auth.groupId,input.title,input.details??null])).rows[0]!.id;
      }else{
        const row=await read(client,auth,audience.spaceId,input.id!,true);id=row.id;
        if(row.version!==input.version)throw new AppError("AGENT_DECISION_VERSION_CONFLICT","Решение изменилось. Прочитайте его заново");
        if(input.action==='answer'){
          if(row.cancelled)throw new AppError("AGENT_DECISION_CANCELLED","Предложение отменено; для нового решения нужно новое предложение");
          await client.query(`INSERT INTO joint_decision_answers(decision_id,actor_user_id,choice) VALUES($1,$2,$3)
            ON CONFLICT(decision_id,actor_user_id) DO UPDATE SET choice=excluded.choice,updated_at=now()`,[id,actor,input.choice]);
        }else if(input.action==='cancel'){
          if(row.creator_user_id!==actor)denied();
          await client.query("UPDATE joint_decisions SET cancelled=true WHERE id=$1",[id]);
        }else if(input.action==='feedback'){
          await client.query(`INSERT INTO joint_decision_feedback(decision_id,actor_user_id,text) VALUES($1,$2,$3)
            ON CONFLICT(decision_id,actor_user_id) DO UPDATE SET text=excluded.text,updated_at=now()`,[id,actor,input.text]);
        }else{
          const removed=await client.query("DELETE FROM joint_decision_feedback WHERE decision_id=$1 AND actor_user_id=$2",[id,actor]);
          if(!removed.rowCount)throw new AppError("AGENT_DECISION_FEEDBACK_ABSENT","Вашего отзыва у этого решения нет");
        }
        await client.query("UPDATE joint_decisions SET version=version+1,updated_at=now() WHERE id=$1",[id]);
      }
      await client.query("INSERT INTO joint_decision_operations(family_id,operation_key,decision_id,request_hash) VALUES($1,$2,$3,$4)",[auth.familyId,operationKey,id,hash]);
      await client.query(`INSERT INTO audit_events(family_id,actor_user_id,event_type,subject_id)
        VALUES($1,$2,'joint_decision.'||$3::text,$4)`,[auth.familyId,actor,input.action,id]);
      const decision=await present(client,await read(client,auth,audience.spaceId,id),actor);
      await client.query("COMMIT");return {decision,replayed:false};
    }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  },
};
