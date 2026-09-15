/** Atomic reservations. Caller supplies a verified Telegram person, never model-authored identity. */
import type {PoolClient} from 'pg';
import {database} from '../database.js';
import {AppError} from '../app-error.js';
import {VIDEO_MONTHLY_LIMIT_MICROS} from './video-pricing.js';

interface Reservation {
  operation_key:string; actor_telegram_id:string; month:string; input_hash:string;
  reserved_micros:string; actual_micros:string|null;
}
const currentMonth="to_char(timezone('Europe/Moscow',now()),'YYYY-MM')";
function invalid(){return new AppError('AGENT_VIDEO_BUDGET_INPUT_INVALID','Не удалось проверить резерв стоимости видео');}
function actor(value:string){if(!/^[1-9][0-9]{0,18}$/u.test(value))throw invalid();}
async function transaction<T>(run:(client:PoolClient)=>Promise<T>):Promise<T>{
  const client=await database().connect();
  try{await client.query('BEGIN');const result=await run(client);await client.query('COMMIT');return result;}
  catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function usage(client:Pick<PoolClient,'query'>,id:string,month:string):Promise<number>{
  const row=(await client.query<{used:string}>(`SELECT COALESCE(SUM(COALESCE(actual_micros,reserved_micros)),0)::text AS used
    FROM video_budget_reservations WHERE actor_telegram_id=$1 AND month=$2`,[id,month])).rows[0]!;
  const used=Number(row.used);
  if(!Number.isSafeInteger(used))throw invalid();
  return used;
}

export const videoBudgetRepository={
  async reserve(input:{actorTelegramId:string;operationKey:string;inputHash:string;reservedMicros:number},
    prepare?:(client:PoolClient)=>Promise<void>){
    actor(input.actorTelegramId);
    if(!input.operationKey||input.operationKey.length>500||!/^[a-f0-9]{64}$/u.test(input.inputHash)||
      !Number.isSafeInteger(input.reservedMicros)||input.reservedMicros<=0||input.reservedMicros>VIDEO_MONTHLY_LIMIT_MICROS)throw invalid();
    return transaction(async client=>{
      // Replays retain their original month, including a request continued after midnight.
      const previous=(await client.query<Reservation>('SELECT * FROM video_budget_reservations WHERE operation_key=$1',[input.operationKey])).rows[0];
      const replay=(row:Reservation)=>{
        if(row.actor_telegram_id!==input.actorTelegramId||row.input_hash!==input.inputHash) {
          throw new AppError('AGENT_VIDEO_REPLAY_MISMATCH','Повтор видеозапроса не совпадает с исходным');
        }
        return {execute:false,month:row.month,reservedMicros:Number(row.reserved_micros)};
      };
      if(previous)return replay(previous);
      const month=(await client.query<{month:string}>(`SELECT ${currentMonth} AS month`)).rows[0]!.month;
      await client.query('INSERT INTO video_budget_accounts(actor_telegram_id,month) VALUES($1,$2) ON CONFLICT DO NOTHING',[input.actorTelegramId,month]);
      await client.query('SELECT 1 FROM video_budget_accounts WHERE actor_telegram_id=$1 AND month=$2 FOR UPDATE',[input.actorTelegramId,month]);
      const again=(await client.query<Reservation>('SELECT * FROM video_budget_reservations WHERE operation_key=$1',[input.operationKey])).rows[0];
      if(again)return replay(again);
      const used=await usage(client,input.actorTelegramId,month);
      if(used+input.reservedMicros>VIDEO_MONTHLY_LIMIT_MICROS)throw new AppError('AGENT_VIDEO_BUDGET_EXCEEDED',
        'Для этого видео недостаточно месячного лимита $30. Незавершённые генерации тоже учитываются');
      const inserted=await client.query(`INSERT INTO video_budget_reservations(operation_key,actor_telegram_id,month,input_hash,reserved_micros)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[input.operationKey,input.actorTelegramId,month,input.inputHash,input.reservedMicros]);
      if(!inserted.rowCount)return replay((await client.query<Reservation>('SELECT * FROM video_budget_reservations WHERE operation_key=$1',[input.operationKey])).rows[0]!);
      // The job start marker is committed with its budget hold, never in a second transaction.
      if(prepare)await prepare(client);
      return {execute:true,month,reservedMicros:input.reservedMicros};
    });
  },
  async settle(operationKey:string,actualMicros:number){
    if(!Number.isSafeInteger(actualMicros)||actualMicros<0)throw invalid();
    return transaction(async client=>{
      const row=(await client.query<Reservation>('SELECT * FROM video_budget_reservations WHERE operation_key=$1',[operationKey])).rows[0];
      if(!row)throw new AppError('AGENT_VIDEO_NOT_FOUND','Резерв видеозадания не найден');
      await client.query('SELECT 1 FROM video_budget_accounts WHERE actor_telegram_id=$1 AND month=$2 FOR UPDATE',[row.actor_telegram_id,row.month]);
      const updated=await client.query(`UPDATE video_budget_reservations SET actual_micros=$2,settled_at=COALESCE(settled_at,now())
        WHERE operation_key=$1 AND (actual_micros IS NULL OR actual_micros=$2)`,[operationKey,actualMicros]);
      if(!updated.rowCount)throw new AppError('AGENT_VIDEO_COST_CONFLICT','Сервис сообщил другую стоимость уже учтённого видео');
    });
  },
  async balance(actorTelegramId:string){
    actor(actorTelegramId);
    const month=(await database().query<{month:string}>(`SELECT ${currentMonth} AS month`)).rows[0]!.month;
    const usedMicros=await usage(database(),actorTelegramId,month);
    return {month,usedMicros,limitMicros:VIDEO_MONTHLY_LIMIT_MICROS,remainingMicros:Math.max(0,VIDEO_MONTHLY_LIMIT_MICROS-usedMicros)};
  },
};
