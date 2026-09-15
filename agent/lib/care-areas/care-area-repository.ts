/**
 * Области заботы: целое дело жизни, у которого есть хозяин.
 *
 * Экспорт:
 * - `careAreaInput`: проверенный ввод инструмента.
 * - `careAreaRepository`: чтение и переходы состояния области.
 *
 * Поштучные поручения не описывают «машину» или «садик»: второй взрослый всё равно держит их в
 * голове, чтобы ничего не забыли. Область заботы говорит, что этим занимается вот этот человек
 * целиком.
 *
 * Хозяин появляется только через явное согласие: предложить можно кому угодно, назначить нельзя
 * никого. Отказ и отказ от ведения возвращают область в свободные, и её бесхозность видна всем.
 * Рейтинга вклада здесь нет: сравнение «кто больше сделал» это то, ради чего семьи ботом
 * пользоваться перестают.
 */
import type { PoolClient } from "pg";
import { z } from "zod";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { authorize, denied, participants } from "../shared-task-access.js";
import { requireWriteSpace } from "../spaces/space-write.js";
import { authorizeRecordSpaceAction } from "../spaces/space-access.js";
import { CARE_AREA_VISIBILITY, careAreaSpaceValues } from "./care-area-access.js";

export const careAreaInput = z.object({
  action: z.enum(["list", "create", "propose", "accept", "decline", "release", "retire"]),
  details: z.string().trim().min(1).max(1000).optional(),
  id: z.uuid().optional(),
  ownerRef: z.uuid().optional(),
  title: z.string().trim().min(1).max(100).optional(),
  version: z.number().int().positive().optional(),
}).strict();

export type CareAreaInput = z.infer<typeof careAreaInput>;

interface CareAreaRow {
  details: string | null;
  id: string;
  owner: string | null;
  owner_telegram_id: string | null;
  pending_owner: string | null;
  pending_owner_telegram_id: string | null;
  status: string;
  title: string;
  version: number;
  space_id: string | null;
}

const COLUMNS = `area.id, area.title, area.details, area.status, area.version, area.space_id,
  area.owner_telegram_id, area.pending_owner_telegram_id,
  owner.display_name AS owner, pending.display_name AS pending_owner`;
const JOINS = `LEFT JOIN users owner ON owner.telegram_user_id = area.owner_telegram_id
  LEFT JOIN users pending ON pending.telegram_user_id = area.pending_owner_telegram_id`;

function present(row: CareAreaRow) {
  return {
    details: row.details,
    id: row.id,
    owner: row.owner,
    pendingOwner: row.pending_owner,
    status: row.status,
    title: row.title,
    version: row.version,
  };
}

export const careAreaRepository = {
  async execute(auth: MemoryAuthorization, raw: CareAreaInput) {
    const parsed = careAreaInput.safeParse(raw);
    if (!parsed.success) {
      throw new AppError("AGENT_CARE_AREA_INPUT_INVALID", "Проверьте действие и поля области заботы");
    }
    const input = parsed.data;
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const scope = await authorize(client, auth);
      // Право записи спрашивается только у изменения: роль, которая читает область и не меняет
      // её, обязана видеть, кто что ведёт, — иначе она не увидит и своей собственной области.
      const spaceId = input.action === "list" ? null : await requireWriteSpace(client, {
        chatType: auth.groupId === null ? "private" : "supergroup",
        familyId: auth.familyId,
        groupId: auth.groupId,
        ...(auth.space ? { space: auth.space } : {}),
        userId: auth.userId,
      });
      // Личная область заботы бессмысленна: заботиться за себя перед собой не нужно, поэтому в
      // личном чате видно и ведётся семейное.
      const chatScope = scope === "group" ? "group" : "family";
      const groupId = scope === "group" ? auth.groupId : null;
      const actor = auth.telegramUserId!;

      if (input.action === "list") {
        const { rows } = await client.query<CareAreaRow>(
          `SELECT ${COLUMNS} FROM care_areas area ${JOINS}
            WHERE ($1::uuid IS NULL) AND area.family_id=$2 AND area.scope=$3 AND area.group_id IS NOT DISTINCT FROM $4::uuid
              AND area.status <> 'retired' AND ${CARE_AREA_VISIBILITY}
            ORDER BY area.status, lower(area.title) LIMIT 100`,
          [null, auth.familyId, chatScope, groupId, ...careAreaSpaceValues(auth)],
        );
        await client.query("COMMIT");
        return { areas: rows.map(present) };
      }

      if (input.action === "create") {
        if (!input.title) denied();
        const created = await client.query<{ id: string }>(
          `INSERT INTO care_areas(family_id,space_id,group_id,scope,title,details,creator_telegram_id)
           VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [auth.familyId, spaceId, groupId, chatScope, input.title, input.details ?? null, actor],
        ).catch((error: unknown) => {
          if (error instanceof Error && error.message.includes("care_areas_title")) {
            throw new AppError("AGENT_CARE_AREA_DUPLICATE", "Область с таким названием уже есть");
          }
          throw error;
        });
        const row = await this.read(client, auth, created.rows[0]!.id, chatScope, groupId);
        await client.query("COMMIT");
        return { area: row };
      }

      if (!input.id || !input.version) {
        throw new AppError(
          "AGENT_CARE_AREA_INPUT_INVALID",
          "Нужны id и актуальная version области из list",
        );
      }
      const locked = (await client.query<CareAreaRow & { creator_telegram_id: string }>(
        `SELECT ${COLUMNS}, area.creator_telegram_id FROM care_areas area ${JOINS}
          WHERE area.id=$1 AND area.family_id=$2 AND area.scope=$3
            AND area.group_id IS NOT DISTINCT FROM $4::uuid AND area.status <> 'retired'
            AND ${CARE_AREA_VISIBILITY}`,
        [input.id, auth.familyId, chatScope, groupId, ...careAreaSpaceValues(auth)],
      )).rows[0];
      if (!locked) denied();
      if (locked.space_id !== null) await authorizeRecordSpaceAction(client, {
        chat: auth.groupId === null ? { type: "private" } : { type: "supergroup", groupId: auth.groupId },
        familyId: auth.familyId, spaceId: locked.space_id, userId: auth.userId,
      }, "write");
      // Lock the parent space before the record, in the same order as membership changes.
      const current = (await client.query<{ version: number }>(
        "SELECT version FROM care_areas WHERE id=$1 FOR UPDATE", [locked.id],
      )).rows[0];
      if (!current || current.version !== input.version || current.version !== locked.version) {
        throw new AppError(
          "AGENT_CARE_AREA_STALE",
          "Область уже изменили. Прочитайте list заново и повторите с актуальной version",
        );
      }

      if (input.action === "propose") {
        if (!input.ownerRef) denied();
        await participants(client, auth, scope);
        const candidate = (await client.query<{ telegram_user_id: string }>(
          `SELECT p.telegram_user_id FROM shared_task_participants p
            WHERE p.id=$1 AND p.family_id=$2 AND p.group_id IS NOT DISTINCT FROM $3::uuid
              AND ($3::uuid IS NOT NULL OR EXISTS (SELECT 1 FROM users u
                JOIN family_memberships m ON m.user_id=u.id
                WHERE m.family_id=$2 AND u.telegram_user_id=p.telegram_user_id))
              AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM users u
                JOIN space_memberships sm ON sm.user_id=u.id
                WHERE sm.family_id=$2 AND sm.space_id=$4 AND sm.state='active'
                  AND u.telegram_user_id=p.telegram_user_id))`,
          [input.ownerRef, auth.familyId, groupId, locked.space_id],
        )).rows[0];
        if (!candidate) denied();
        if (candidate.telegram_user_id === locked.owner_telegram_id) denied();
        await client.query(
          `UPDATE care_areas SET status='proposed', owner_telegram_id=NULL,
             pending_owner_telegram_id=$2, proposed_at=now(), accepted_at=NULL,
             version=version+1, updated_at=now() WHERE id=$1`,
          [locked.id, candidate.telegram_user_id],
        );
      } else if (input.action === "accept") {
        // Принимает только тот, кому предложили: область берут целиком и по своей воле.
        if (locked.pending_owner_telegram_id !== actor) denied();
        await client.query(
          `UPDATE care_areas SET status='accepted', owner_telegram_id=pending_owner_telegram_id,
             pending_owner_telegram_id=NULL, proposed_at=NULL, accepted_at=now(),
             version=version+1, updated_at=now() WHERE id=$1`,
          [locked.id],
        );
      } else if (input.action === "decline") {
        if (locked.pending_owner_telegram_id !== actor && locked.creator_telegram_id !== actor) denied();
        await client.query(
          `UPDATE care_areas SET status='open', pending_owner_telegram_id=NULL, proposed_at=NULL,
             version=version+1, updated_at=now() WHERE id=$1`,
          [locked.id],
        );
      } else if (input.action === "release") {
        // Отказ хозяина не назначает никого: бесхозная область видна всем, и это честнее тишины.
        if (locked.owner_telegram_id !== actor) denied();
        await client.query(
          `UPDATE care_areas SET status='open', owner_telegram_id=NULL, accepted_at=NULL,
             version=version+1, updated_at=now() WHERE id=$1`,
          [locked.id],
        );
      } else {
        if (locked.owner_telegram_id !== actor && locked.creator_telegram_id !== actor) denied();
        await client.query(
          `UPDATE care_areas SET status='retired', pending_owner_telegram_id=NULL, proposed_at=NULL,
             version=version+1, updated_at=now() WHERE id=$1`,
          [locked.id],
        );
      }
      const row = await this.read(client, auth, locked.id, chatScope, groupId);
      await client.query("COMMIT");
      return { area: row };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async read(
    client: PoolClient,
    auth: MemoryAuthorization,
    id: string,
    scope: string,
    groupId: string | null,
  ) {
    const { rows } = await client.query<CareAreaRow>(
      `SELECT ${COLUMNS} FROM care_areas area ${JOINS}
        WHERE area.id=$1 AND area.family_id=$2 AND area.scope=$3
          AND area.group_id IS NOT DISTINCT FROM $4::uuid AND ${CARE_AREA_VISIBILITY}`,
      [id, auth.familyId, scope, groupId, ...careAreaSpaceValues(auth)],
    );
    const row = rows[0];
    if (!row) denied();
    return present(row);
  },
};
