/**
 * Публикация записи в другую область.
 *
 * Экспорт:
 * - `PublicationTarget`, `listPublicationTargets`: области, куда этот человек вправе публиковать.
 * - `publishMemory`: самостоятельная копия записи в выбранной области.
 *
 * Перенести запись в другую область значит расширить круг её читателей, поэтому это отдельная
 * операция с согласием автора, а не побочный эффект разговора. Здесь впервые применяется право
 * `publish` из матрицы ролей: до этого проверялось только чтение, и роли различались лишь на бумаге.
 *
 * Копия самостоятельна: в целевой области появляется текст и пометка о публикации, но не ссылка на
 * исходную запись, не её доказательства и не скрытая история. Связь с оригиналом остаётся на
 * стороне источника — в журнале событий семьи, под её правами.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { selectAuthorizedMemory } from "../memory-authorized-lookup.js";
import { memoryRepository } from "../memory-repository.js";
import type { MemoryKind } from "../memory-record.js";
import { listOwnSpaces } from "../spaces/active-space.js";
import { authorizeSpaceAction } from "../spaces/space-access.js";

export interface PublicationTarget {
  readonly areaRef: string;
  readonly readers: string[];
  readonly title: string;
}

function denied(): never {
  throw new AppError(
    "AGENT_MEMORY_PUBLISH_DENIED",
    "В эту область публиковать нельзя: выберите её из списка доступных",
  );
}

function requirePrivateAuthor(auth: MemoryAuthorization): string {
  // Публикуют из своего чата: в общем чате человек и так пишет прямо в его область.
  if (auth.groupId !== null || !auth.userId || auth.role === "external") {
    throw new AppError(
      "AGENT_MEMORY_PUBLISH_CHAT_INVALID",
      "Публиковать запись можно из личного чата",
    );
  }
  return auth.userId;
}

async function publishableAreas(
  client: PoolClient,
  auth: MemoryAuthorization,
  userId: string,
): Promise<PublicationTarget[]> {
  const areas = await listOwnSpaces(client, auth.familyId, userId);
  const allowed: PublicationTarget[] = [];
  for (const area of areas) {
    // Читать область может и ребёнок; публиковать в неё — только роль с этим правом.
    if (area.kind === "personal") continue;
    try {
      const access = await authorizeSpaceAction(client, {
        chat: { type: "private" },
        familyId: auth.familyId,
        policyVersion: (await client.query<{ policy_version: number }>(
          "SELECT policy_version FROM spaces WHERE id=$1", [area.spaceId],
        )).rows[0]!.policy_version,
        spaceId: area.spaceId,
        userId,
      }, "publish");
      allowed.push({ areaRef: access.spaceId, readers: area.readers, title: area.title });
    } catch {
      // Отсутствие права это обычное состояние, а не сбой: область просто не предлагается.
    }
  }
  return allowed;
}

export async function listPublicationTargets(
  auth: MemoryAuthorization,
): Promise<PublicationTarget[]> {
  const userId = requirePrivateAuthor(auth);
  const client = await database().connect();
  try {
    return await publishableAreas(client, auth, userId);
  } finally {
    client.release();
  }
}

export interface PublicationPreview {
  readonly content: string;
  readonly kind: MemoryKind;
  readonly targetTitle: string;
}

/** Точный текст, который уйдёт в чужую область, показывается до согласия, а не после. */
export async function previewPublication(
  auth: MemoryAuthorization,
  input: { areaRef: string; memoryRef: string },
): Promise<PublicationPreview> {
  const userId = requirePrivateAuthor(auth);
  const client = await database().connect();
  try {
    const target = (await publishableAreas(client, auth, userId))
      .find((area) => area.areaRef === input.areaRef);
    if (!target) denied();
    const source = await selectAuthorizedMemory(client, auth, input.memoryRef, "ref");
    if (!source) {
      throw new AppError("AGENT_MEMORY_REF_INVALID", "Запись не найдена в разрешённой области памяти");
    }
    return { content: source.content, kind: source.kind, targetTitle: target.title };
  } finally {
    client.release();
  }
}

export async function publishMemory(
  auth: MemoryAuthorization,
  input: { areaRef: string; memoryRef: string },
  operationKey: string,
): Promise<{ content: string; memoryRef: string; readers: string[]; targetTitle: string }> {
  const userId = requirePrivateAuthor(auth);
  const client = await database().connect();
  let preview: PublicationPreview & { readers: string[] };
  try {
    const target = (await publishableAreas(client, auth, userId))
      .find((area) => area.areaRef === input.areaRef);
    if (!target) denied();
    const source = await selectAuthorizedMemory(client, auth, input.memoryRef, "ref");
    if (!source) {
      throw new AppError("AGENT_MEMORY_REF_INVALID", "Запись не найдена в разрешённой области памяти");
    }
    preview = {
      content: source.content, kind: source.kind, readers: target.readers, targetTitle: target.title,
    };
  } finally {
    client.release();
  }

  const version = (await database().query<{ policy_version: number }>(
    "SELECT policy_version FROM spaces WHERE id=$1", [input.areaRef],
  )).rows[0];
  if (!version) denied();
  // Копия пишется обычным путём записи: право писать в целевую область проверяется ещё раз, уже
  // внутри транзакции, вместе с блокировкой самой области.
  const published = await memoryRepository.create({
    ...auth,
    space: { policyVersion: version.policy_version, spaceId: input.areaRef },
  }, {
    confirmation: "user_confirmed",
    content: preview.content,
    kind: preview.kind,
    operationKey,
    scope: "family",
    sensitivity: "normal",
    source: "publication",
  });
  await database().query(
    `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
     VALUES ($1,$2,'memory.published',$3, jsonb_build_object('target', $4::uuid))`,
    [auth.familyId, userId, published.id, input.areaRef],
  );
  return {
    content: preview.content,
    memoryRef: published.memoryRef,
    readers: preview.readers,
    targetTitle: preview.targetTitle,
  };
}
