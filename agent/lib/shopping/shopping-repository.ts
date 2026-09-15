/**
 * Список покупок: общий по области, без исполнителя, с отметкой покупки.
 *
 * Экспорт:
 * - `shoppingInput`: проверенный ввод инструмента.
 * - `shoppingRepository`: добавление, выдача, отметка покупки и её отмена, удаление.
 *
 * Отметка «куплено» это автор и время вместе, а не статус задачи: список ведут вдвоём, и важно,
 * кто именно уже взял пункт. Параллельные добавления не теряются — у пунктов нет уникальности по
 * названию; повтор одного и того же действия не создаёт второй пункт, потому что ключ операции
 * хранится. Случайную отметку можно снять.
 */
import { createHash } from "node:crypto";
import { z } from "zod";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { authorizeRecordSpaceAction } from "../spaces/space-access.js";
import { requireWriteSpace } from "../spaces/space-write.js";
import {
  SHOPPING_VISIBILITY,
  authorizeShopping,
  presentShoppingItem,
  shoppingDenied,
  shoppingVisibilityValues,
  type ShoppingRow,
} from "./shopping-access.js";

export const shoppingInput = z.object({
  action: z.enum(["add", "list", "buy", "unbuy", "remove"]),
  id: z.uuid().optional(),
  listName: z.string().trim().min(1).max(100).optional(),
  note: z.string().trim().min(1).max(500).nullable().optional(),
  quantity: z.string().trim().min(1).max(50).nullable().optional(),
  title: z.string().trim().min(1).max(200).optional(),
  version: z.number().int().positive().optional(),
  view: z.enum(["open", "bought", "all"]).optional(),
}).strict().superRefine((value, ctx) => {
  const fields: Record<string, string[]> = {
    add: ["listName", "title", "quantity", "note"],
    buy: ["id", "version"], list: ["listName", "view"],
    remove: ["id", "version"], unbuy: ["id", "version"],
  };
  for (const key of Object.keys(value)) {
    if (key !== "action" && !fields[value.action]!.includes(key)) {
      ctx.addIssue({ code: "custom", message: `Недопустимое поле ${key} для ${value.action}` });
    }
  }
  if (value.action === "add" && (!value.title || !value.listName)) {
    ctx.addIssue({ code: "custom", message: "Для add нужны listName и title" });
  }
  if (["buy", "unbuy", "remove"].includes(value.action) && (!value.id || !value.version)) {
    ctx.addIssue({ code: "custom", message: "Нужны id и актуальная version из list" });
  }
});

export type ShoppingInput = z.infer<typeof shoppingInput>;

const COLUMNS = `item.id, item.list_name, item.title, item.quantity, item.note, item.version,
  item.bought_at, item.space_id, COALESCE(space.title,'Семья') AS source,
  adder.display_name AS added_by, buyer.display_name AS bought_by`;
const JOINS = `LEFT JOIN users adder ON adder.telegram_user_id=item.added_by_telegram_id
  LEFT JOIN users buyer ON buyer.telegram_user_id=item.bought_by_telegram_id
  LEFT JOIN spaces space ON space.id=item.space_id AND space.family_id=item.family_id`;

/** Область строки живёт в ней самой; NULL означает прежний режим семьи и прежние правила. */
async function requireItemSpaceWrite(
  client: Parameters<typeof authorizeRecordSpaceAction>[0],
  auth: MemoryAuthorization,
  id: string,
): Promise<void> {
  const row = await client.query<{ space_id: string | null }>(
    "SELECT space_id FROM shopping_items WHERE id=$1 AND family_id=$2",
    [id, auth.familyId],
  );
  const spaceId = row.rows[0]?.space_id ?? null;
  if (spaceId === null) return;
  await authorizeRecordSpaceAction(client, {
    chat: auth.groupId === null
      ? { type: "private" }
      : { groupId: auth.groupId, type: "supergroup" },
    familyId: auth.familyId,
    spaceId,
    userId: auth.userId,
  }, "write");
}

async function selectItems(
  client: Parameters<typeof authorizeShopping>[0],
  auth: MemoryAuthorization,
  input: ShoppingInput,
  id: string | null,
): Promise<ShoppingRow[]> {
  const view = input.view ?? "open";
  const result = await client.query<ShoppingRow>(
    `SELECT ${COLUMNS} FROM shopping_items item ${JOINS}
      WHERE ${SHOPPING_VISIBILITY} AND item.removed_at IS NULL
        AND ($6::uuid IS NULL OR item.id=$6::uuid)
        AND ($7::text IS NULL OR item.list_name=$7)
        AND ($8::text='all' OR ($8::text='bought')=(item.bought_at IS NOT NULL))
      ORDER BY item.bought_at NULLS FIRST, item.created_at, item.id LIMIT 200`,
    [...shoppingVisibilityValues(auth), id, input.listName ?? null, view],
  );
  return result.rows;
}

export const shoppingRepository = {
  async execute(auth: MemoryAuthorization, raw: ShoppingInput, operationKey: string) {
    const parsed = shoppingInput.safeParse(raw);
    if (!parsed.success) {
      throw new AppError("AGENT_SHOPPING_INPUT_INVALID", "Проверьте действие и поля пункта списка");
    }
    const input = parsed.data;
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await authorizeShopping(client, auth);
      // Чтение не спрашивает права записи: роль, которая может читать область и не может её
      // менять, обязана видеть список. Иначе «ограничен» превращалось бы в «не существует».
      if (input.action === "list") {
        const rows = await selectItems(client, auth, input, null);
        await client.query("COMMIT");
        return { items: rows.map(presentShoppingItem) };
      }
      // Родительское пространство блокируется раньше живых проверок членства.
      const spaceId = await requireWriteSpace(client, {
        chatType: auth.groupId === null ? "private" : "supergroup",
        familyId: auth.familyId,
        groupId: auth.groupId,
        ...(auth.space ? { space: auth.space } : {}),
        userId: auth.userId,
      });
      if (!operationKey || operationKey.length > 500) shoppingDenied();
      const hash = createHash("sha256")
        .update(JSON.stringify({ actor: auth.telegramUserId, input })).digest("hex");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`${auth.familyId}:shopping:${operationKey}`]);
      const previous = await client.query<{ item_id: string; request_hash: string }>(
        "SELECT item_id,request_hash FROM shopping_item_operations WHERE family_id=$1 AND operation_key=$2",
        [auth.familyId, operationKey],
      );
      if (previous.rows[0]) {
        if (previous.rows[0].request_hash !== hash) shoppingDenied();
        // Повтор и изменение ищут пункт независимо от вида: купленный тоже остаётся своим.
        const [row] = await selectItems(client, auth, { action: "list", view: "all" }, previous.rows[0].item_id);
        if (!row) shoppingDenied();
        await client.query("COMMIT");
        return { item: presentShoppingItem(row), replayed: true };
      }

      let id: string;
      if (input.action === "add") {
        // Одинаковые названия не объединяются: два человека кладут два пакета молока намеренно.
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO shopping_items
             (family_id, space_id, list_name, title, quantity, note, added_by_telegram_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [auth.familyId, spaceId, input.listName, input.title,
            input.quantity ?? null, input.note ?? null, auth.telegramUserId],
        );
        id = inserted.rows[0]!.id;
      } else {
        const [visible] = await selectItems(client, auth, { action: "list", view: "all" }, input.id!);
        if (!visible) shoppingDenied();
        // Право менять спрашивается у области самого пункта: активная область хода говорит лишь
        // о том, куда пойдёт новая запись, а не о том, что можно сделать с чужой.
        await requireItemSpaceWrite(client, auth, input.id!);
        const locked = await client.query<{ bought_at: Date | null; version: number }>(
          "SELECT bought_at,version FROM shopping_items WHERE id=$1 FOR UPDATE", [input.id],
        );
        const current = locked.rows[0];
        if (!current) shoppingDenied();
        if (current.version !== input.version) {
          throw new AppError(
            "AGENT_SHOPPING_VERSION_STALE",
            "Пункт уже изменили. Прочитайте список заново",
          );
        }
        if (input.action === "buy" && current.bought_at !== null) {
          throw new AppError("AGENT_SHOPPING_ALREADY_BOUGHT", "Этот пункт уже отмечен купленным");
        }
        if (input.action === "unbuy" && current.bought_at === null) {
          throw new AppError("AGENT_SHOPPING_NOT_BOUGHT", "Этот пункт ещё не отмечен купленным");
        }
        const changes = input.action === "remove"
          ? "removed_at=now()"
          : input.action === "buy"
          ? "bought_at=now(), bought_by_telegram_id=$2"
          : "bought_at=NULL, bought_by_telegram_id=NULL";
        await client.query(
          `UPDATE shopping_items SET ${changes}, version=version+1, updated_at=now() WHERE id=$1`,
          input.action === "buy" ? [input.id, auth.telegramUserId] : [input.id],
        );
        id = input.id!;
      }
      await client.query(
        `INSERT INTO shopping_item_operations
           (family_id, operation_key, actor_telegram_id, request_hash, item_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [auth.familyId, operationKey, auth.telegramUserId, hash, id],
      );
      const [row] = await selectItems(client, auth, { action: "list", view: "all" }, id);
      await client.query("COMMIT");
      return { item: row ? presentShoppingItem(row) : null, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  },
};
