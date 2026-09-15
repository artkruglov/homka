/**
 * Область, в которую пишется строка с отложенной доставкой.
 *
 * Экспорт:
 * - `SpaceWriteRequest`: проверенный чат хода и доказанная им область.
 * - `requireWriteSpace`: право писать в эту область либо прежний режим семьи.
 * - `requireBoundDestinationSpace`: область чата-адресата, когда ход идёт не в нём.
 *
 * Доказательство хода живёт ровно один ход, а напоминание или расписание доживают до срока.
 * Поэтому строка запоминает свою область: без неё `isSpaceDestinationProven` перед отправкой
 * нечего будет сверять, и адресата пришлось бы угадывать по типу чата.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { readFamilySpaceMode } from "./family-space-mode.js";
import { authorizeSpaceAction,type SpaceAction } from "./space-access.js";
import type { SpaceAttributes } from "./space-attributes.js";

export interface SpaceWriteRequest {
  readonly chatType: "group" | "private" | "supergroup";
  readonly familyId: string;
  readonly groupId: string | null;
  readonly space?: SpaceAttributes;
  readonly userId: string | null;
}

export async function requireWriteSpace(
  client: PoolClient,
  request: SpaceWriteRequest,
): Promise<string | null> {
  return requireSpaceAction(client,request,"write");
}

/** Same proven-context boundary, with an action narrower than general content mutation. */
export async function requireSpaceAction(
  client:PoolClient,request:SpaceWriteRequest,action:SpaceAction,
):Promise<string|null> {
  if (!request.space) {
    // Пока режим прежний, строка без области ведёт себя как раньше; после включения это забытый
    // путь, и молчаливое согласие оставило бы отложенную доставку без доказуемого адресата.
    if (await readFamilySpaceMode(client, request.familyId) === "spaces") {
      throw new AppError("AGENT_SPACE_CONTEXT_REQUIRED", "Область разговора не подтверждена. Начните новый диалог");
    }
    return null;
  }
  const access = await authorizeSpaceAction(client, {
    chat: request.groupId === null
      ? { type: "private" }
      : { groupId: request.groupId, type: request.chatType === "group" ? "group" : "supergroup" },
    familyId: request.familyId,
    policyVersion: request.space.policyVersion,
    spaceId: request.space.spaceId,
    userId: request.userId,
  }, action);
  return access.spaceId;
}

/**
 * Владелец заводит автоматизацию внешней группы из своей лички, поэтому область адресата даёт не
 * ход, а подтверждённая привязка самого чата. Неподтверждённый состав отказывает сразу: строка без
 * области после включения режима всё равно не пройдёт доказательство перед отправкой.
 */
export async function requireBoundDestinationSpace(
  client: PoolClient,
  familyId: string,
  groupId: string,
): Promise<string | null> {
  if (await readFamilySpaceMode(client, familyId) !== "spaces") return null;
  const bound = await client.query<{ space_id: string }>(
    "SELECT space_id FROM space_bindings WHERE family_id=$1 AND group_id=$2 AND state='active'",
    [familyId, groupId],
  );
  const spaceId = bound.rows[0]?.space_id;
  if (!spaceId) {
    throw new AppError("AGENT_SPACE_BINDING_UNPROVEN", "Состав этого чата ещё не подтверждён");
  }
  return spaceId;
}
