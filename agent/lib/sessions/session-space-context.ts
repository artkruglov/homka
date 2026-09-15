/** Trusted space selection for the existing session repository, not a model-facing selector. */
import type { PoolClient } from "pg";
import { AppError } from "../app-error.js";
import { readFamilySpaceMode } from "../spaces/family-space-mode.js";
import { resolveSpaceAccess, type SpaceContext } from "../spaces/space-access.js";

export interface SessionSpacePolicy { spaceId: string; policyVersion: number; title: string }
interface SelectionInput { familyId: string; groupId: string | null; userId: string | null; spaceContext?: SpaceContext }

export async function resolveSessionSpacePolicy(client: PoolClient, input: SelectionInput): Promise<SessionSpacePolicy | null> {
  const context = input.spaceContext;
  if (!context) {
    // Пока режим семьи прежний, отсутствие области и есть прежнее поведение. После включения
    // путь без области означает, что его забыли перевести: он обязан упасть громко, а не
    // молча остаться прежним, иначе именно через него и утечёт чужая запись.
    if (await readFamilySpaceMode(client, input.familyId) === "spaces") {
      throw new AppError("AGENT_SPACE_CONTEXT_REQUIRED", "Область разговора не подтверждена. Начните новый диалог");
    }
    return null;
  }
  if (context.familyId !== input.familyId || (context.chat.type === "private"
    ? input.groupId !== null || context.userId !== input.userId
    : context.chat.groupId !== input.groupId)) {
    throw new AppError("AGENT_SESSION_SPACE_CONTEXT_INVALID", "Область разговора не соответствует проверенному отправителю и чату");
  }
  const access = await resolveSpaceAccess(client, context);
  return { spaceId: access.spaceId, policyVersion: access.policyVersion, title: access.title };
}

export function sessionSpaceChanged(
  row: { space_id: string | null; space_policy_version: number | null },
  policy: SessionSpacePolicy | null,
): boolean {
  // Бэкфилл 104 проставляет space_id всей прежней истории, а версию политики миграция 106
  // намеренно оставляет пустой. Привязанной считается только сессия с версией.
  if (!policy && row.space_policy_version !== null) {
    throw new AppError("AGENT_SESSION_SPACE_CONTEXT_REQUIRED", "Для продолжения нужен проверенный контекст пространства");
  }
  return policy !== null && (row.space_id !== policy.spaceId || row.space_policy_version !== policy.policyVersion);
}
