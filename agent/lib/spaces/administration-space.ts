/** Owner operations originate in a verified private chat; this adds its live space boundary. */
import type { PoolClient } from "pg";
import type { SpaceAttributes } from "./space-attributes.js";
import { requireSpaceAction } from "./space-write.js";
export async function requireAdministrationSpace(client:PoolClient,familyId:string,userId:string,space?:SpaceAttributes) {
  await requireSpaceAction(client,{familyId,userId,groupId:null,chatType:"private",...(space?{space}:{})},"manage_members");
}
