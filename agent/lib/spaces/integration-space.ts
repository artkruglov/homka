/** Keep the live integration grant through an external call; legacy mode keeps its old boundary. */
import { database } from "../database.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { authorize,denied } from "../shared-task-access.js";
import { requireSpaceAction } from "./space-write.js";

export async function withIntegrationSpace<T>(auth:MemoryAuthorization,operation:()=>Promise<T>):Promise<T> {
  if(auth.role==="external" || !auth.userId) denied();
  const client=await database().connect();
  try {
    await client.query("BEGIN");
    await requireSpaceAction(client,{familyId:auth.familyId,userId:auth.userId,groupId:auth.groupId,
      chatType:auth.groupId?"supergroup":"private",...(auth.space?{space:auth.space}:{})},"use_integrations");
    await authorize(client,auth);
    const result=await operation();
    await client.query("COMMIT");return result;
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
}
