/**
 * Выбор активной области личного чата.
 *
 * Экспорт:
 * - `manage_space`: карточка чата — что я здесь умею, кто это видит, куда попадёт новая запись.
 *
 * Читать в личном чате человек может все свои области сразу, поэтому переключатель не открывает и
 * не закрывает доступ. Он решает единственное: куда попадёт новая запись и какой областью
 * представится следующий ход. Права проверяет backend по членству, а не по тексту модели;
 * идентификатор области приходит из этого же перечисления и подтверждается заново.
 */
import { defineTool } from "eve/tools";
import { manageSpaceInput } from "../spaces/manage-space-contract.js";
import { spaceRoleRepository } from "../spaces/space-role-repository.js";
import { requireToolApprovalEvidence } from "../require-tool-approval-evidence.js";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { requireMemoryAuthorization } from "../memory-context.js";
import { boundChatSpace, listOwnSpaces, setActiveSpace } from "../spaces/active-space.js";
import { chatCapabilities } from "../spaces/chat-capabilities.js";
import { buildModeToolSurface } from "../tool-policy/mode-tool-surface.js";

export default defineTool({
  approval: ({toolInput}) => {
    const input=manageSpaceInput.parse(toolInput);
    return input.action === "set_role" ? "user-approval" : "not-applicable";
  },
  description: [
    "Карточка текущего чата: status показывает, что я здесь умею, кто видит записи и куда они попадают; switch меняет активную область по areaRef из status.",
    "В ответе readers — кто читает область сейчас. На вопрос кто увидит запись отвечай по этому списку, а не по типу чата и не по родству.",
    "Активная область решает, куда попадёт новая запись памяти и файл; читать человек может все свои области в личном чате независимо от выбора.",
    "Вызывай switch только по явной просьбе человека и передавай areaRef ровно из последнего status, не угадывай по названию.",
    "После переключения следующий ход начинает чистый контекст: прежние цитаты и вложения в него не переносятся.",
    "Владелец с правом управления областью вызывает members с areaRef, затем set_role с memberRef, policyVersion из members и role helper|child. Покажи участника, область и новую роль; изменение требует подтверждения. Понижение действует сразу; расширение прав требует нового пространства. Роль не открывает чужие личные задачи.",
  ].join(" "),
  inputSchema: manageSpaceInput,
  async execute(input, ctx) {
    const auth = requireMemoryAuthorization(ctx);
    if (!auth.userId || auth.role === "external") {
      throw new AppError("AGENT_SPACE_CARD_CHAT_INVALID", "Карточка чата доступна только участнику семьи");
    }
    if (input.action === "members" || input.action === "set_role") {
      const attributes=ctx.session.auth.current?.attributes;
      if(ctx.session.parent || attributes?.scheduledRunId !== undefined || attributes?.memoryReviewBatchId !== undefined)
        throw new AppError("AGENT_SPACE_ROLE_INTERACTIVE_ONLY","Роли меняются в разговоре с владельцем");
      if(input.action === "members") return spaceRoleRepository.members(auth,input.areaRef!);
      await requireToolApprovalEvidence(ctx,"manage_space",input);
      return spaceRoleRepository.assign(auth,{areaRef:input.areaRef!,memberRef:input.memberRef!,role:input.role!,policyVersion:input.policyVersion!});
    }
    // Область общего чата задана привязкой: выбирать в нём нечего, и подмена была бы обманом.
    if (input.action === "switch" && auth.groupId !== null) {
      throw new AppError(
        "AGENT_SPACE_SWITCH_CHAT_INVALID",
        "Область выбирается в личном чате: у общего чата она задана его привязкой",
      );
    }
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      if (input.action === "switch") {
        await setActiveSpace(client, {
          familyId: auth.familyId, spaceId: input.areaRef!, userId: auth.userId,
        });
      }
      const areas = auth.groupId === null
        ? await listOwnSpaces(client, auth.familyId, auth.userId)
        : [await boundChatSpace(client, auth.familyId, auth.groupId)]
          .filter((area) => area !== null);
      await client.query("COMMIT");
      // Возможности перечисляются по настоящему набору инструментов этого режима: обещание
      // словами разошлось бы с чатом ровно в тот день, когда набор изменится.
      const surface = buildModeToolSurface(
        auth.groupId === null ? { environment: "private" } : { environment: "family" },
      );
      return {
        areas: areas.map((area) => ({
          active: area.active, areaRef: area.spaceId, kind: area.kind,
          readers: area.readers, title: area.title,
        })),
        can: chatCapabilities(Object.keys(surface)),
        chat: auth.groupId === null ? "private" : "family",
        ...(input.action === "switch"
          ? { switched: true, note: "Следующий ход начнётся в этой области с чистым контекстом" }
          : {}),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
});
