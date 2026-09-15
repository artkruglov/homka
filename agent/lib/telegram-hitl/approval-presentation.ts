/**
 * Semantic Telegram presentation for HITL requests.
 *
 * Exports:
 * - `TelegramApprovalPresenter`: asynchronous trusted approval presentation contract.
 * - `createTelegramApprovalPresenter`: injectable presenter with schedule subject resolution.
 * - `presentTelegramApproval`: production presenter backed by PostgreSQL repositories.
 */
import type { SessionContext } from "eve/context";

import { agentScheduleRepository } from "../agent-schedules/agent-schedule-repository.js";
import type {
  AgentScheduleRecord,
  AgentScheduleRecurrence,
} from "../agent-schedules/agent-schedule-record.js";
import { describeRecurrence } from "../agent-schedules/agent-schedule-recurrence.js";
import {
  type AgentScheduleAuthorization,
  requireAgentScheduleAuthorization,
} from "../agent-schedules/agent-schedule-context.js";
import { AppError } from "../app-error.js";
import { manageSpaceInput } from "../spaces/manage-space-contract.js";
import { spaceRoleRepository,type SpaceRoleSnapshot } from "../spaces/space-role-repository.js";
import { requireMemoryAuthorization } from "../memory-context.js";
import type { GmailMessageApprovalSubject } from "../google-workspace/gmail-message-approval.js";
import { loadGmailMessageApproval } from "../google-workspace/gmail-message-approval.js";
import { requireGmailMessageInput } from "../google-workspace/gmail-message-contract.js";
import {
  localizeTelegramInputRequest,
  type TelegramInputRequest,
} from "../telegram-interface.js";
import {
  GOOGLE_WORKSPACE_CONSEQUENCE,
  SPACE_ROLE_CONSEQUENCE,
  SCHEDULE_CONSEQUENCES,
} from "./approval-consequences.js";
import {
  approvalFact,
  buildApprovalMessage,
  googleWorkspaceFacts,
  sanitizeApprovalLine,
} from "./approval-message.js";

interface ApprovalPresentationDependencies {
  findSpaceMembers?(areaRef:string,ctx:Pick<SessionContext,"session">):Promise<SpaceRoleSnapshot>;
  findGmailMessage(
    messageId: string,
    profileRef: string,
    ctx: Pick<SessionContext, "session">,
  ): Promise<GmailMessageApprovalSubject>;
  findSchedule(auth: AgentScheduleAuthorization, id: string): Promise<AgentScheduleRecord | null>;
}

export type TelegramApprovalPresenter = (
  request: TelegramInputRequest,
  ctx: Pick<SessionContext, "session">,
) => Promise<TelegramInputRequest>;

const SCHEDULE_ACTIONS: Readonly<Record<string, { action: string }>> = {
  create: {
    action: "Создать агентное расписание",
      },
  delete: {
    action: "Удалить агентное расписание",
      },
  pause: {
    action: "Приостановить агентное расписание",
      },
  resume: {
    action: "Возобновить агентное расписание",
      },
  run_now: {
    action: "Запустить агентное расписание сейчас",
      },
  update: {
    action: "Изменить агентное расписание",
      },
};

const GMAIL_MESSAGE_ACTIONS = {
  delete: {
    action: "Безвозвратно удалить письмо Gmail",
    consequence: "Письмо будет удалено навсегда. Его нельзя будет восстановить.",
  },
  mark_read: {
    action: "Отметить письмо Gmail прочитанным",
    consequence: "Письмо больше не будет отмечено как непрочитанное.",
  },
  mark_unread: {
    action: "Отметить письмо Gmail непрочитанным",
    consequence: "Письмо будет отмечено как непрочитанное.",
  },
  restore: {
    action: "Восстановить письмо Gmail из корзины",
    consequence: "Письмо будет возвращено из корзины.",
  },
  trash: {
    action: "Переместить письмо в корзину Gmail",
    consequence: "Письмо будет перемещено в корзину. Его можно будет восстановить.",
  },
} as const;

function approvalValue(value: string | null, missing: string, maxCharacters = 500): string {
  if (value === null) return missing;
  const normalized = value.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (!normalized) return missing;
  return normalized.length <= maxCharacters
    ? normalized
    : `${normalized.slice(0, maxCharacters - 1).trimEnd()}…`;
}

function gmailMessagePrompt(
  actionName: keyof typeof GMAIL_MESSAGE_ACTIONS,
  message: GmailMessageApprovalSubject,
): string {
  const action = GMAIL_MESSAGE_ACTIONS[actionName];
  return [
    "Подтверждение действия",
    "",
    `Действие: ${action.action}`,
    `Профиль: ${message.scope === "personal" ? "личный" : "семейный"}`,
    `Почтовый ящик: ${approvalValue(message.profileDisplayName, "не определён")}`,
    `Отправитель: ${approvalValue(message.from, "не указан")}`,
    `Тема: ${approvalValue(message.subject, "без темы")}`,
    `Дата: ${approvalValue(message.date, "не указана")}`,
    `Фрагмент письма: ${approvalValue(message.snippet, "не предоставлен Gmail", 240)}`,
    `Gmail ID: ${message.id}`,
    "",
    `Что произойдёт: ${action.consequence}`,
  ].join("\n");
}

function gmailMessageOptions(
  request: TelegramInputRequest,
  actionName: keyof typeof GMAIL_MESSAGE_ACTIONS,
): TelegramInputRequest["options"] {
  const approveLabels: Readonly<Record<keyof typeof GMAIL_MESSAGE_ACTIONS, string>> = {
    delete: "Удалить навсегда",
    mark_read: "Отметить прочитанным",
    mark_unread: "Отметить непрочитанным",
    restore: "Восстановить письмо",
    trash: "Переместить в корзину",
  };
  return request.options?.map((option) => ({
    ...option,
    label: option.id === "approve"
      ? approveLabels[actionName]
      : option.id === "deny" || option.id === "cancel"
        ? "Отменить"
        : option.label,
  }));
}

function scheduleDate(schedule: AgentScheduleRecord): string {
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: schedule.timezone,
  }).format(new Date(schedule.nextRunAt));
}

function requestedRecurrence(value: unknown): AgentScheduleRecurrence {
  // Presentation accepts only the recurrence shapes it can explain unambiguously to the user.
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(
      "AGENT_APPROVAL_INPUT_INVALID",
      "Не удалось показать новую периодичность агентного расписания",
    );
  }
  const recurrence = value as Record<string, unknown>;
  if (recurrence.kind === "once") return { kind: "once" };
  if (recurrence.kind === "daily" && typeof recurrence.interval === "number") {
    return { interval: recurrence.interval, kind: "daily" };
  }
  if (
    recurrence.kind === "weekly" &&
    typeof recurrence.interval === "number" &&
    Array.isArray(recurrence.daysOfWeek) &&
    recurrence.daysOfWeek.every((day) => typeof day === "number")
  ) {
    return {
      daysOfWeek: recurrence.daysOfWeek as number[],
      interval: recurrence.interval,
      kind: "weekly",
    };
  }
  throw new AppError(
    "AGENT_APPROVAL_INPUT_INVALID",
    "Не удалось показать новую периодичность агентного расписания",
  );
}

function scheduleChanges(input: Record<string, unknown>): string[] {
  // Show only fields that the approved update will replace; the technical schedule ID is excluded.
  const changes: string[] = [];
  if (typeof input.title === "string") changes.push(`Название: ${input.title}`);
  if (typeof input.userRequest === "string") changes.push(`Назначение: ${input.userRequest}`);
  if (input.recurrence !== undefined) {
    changes.push(`Периодичность: ${describeRecurrence(requestedRecurrence(input.recurrence))}`);
  }
  if (typeof input.nextRunAt === "string") changes.push(`Следующий запуск: ${input.nextRunAt}`);
  if (typeof input.scenarioPrompt === "string") {
    changes.push(`Сценарий: ${input.scenarioPrompt}`);
  }
  if (changes.length === 0) {
    throw new AppError(
      "AGENT_APPROVAL_INPUT_INVALID",
      "Не удалось определить изменения агентного расписания",
    );
  }
  return changes;
}

function schedulePrompt(
  actionName: string,
  schedule: AgentScheduleRecord,
  changes: readonly string[],
): string {
  // Одна и та же структура во всех окнах: заголовок, факты, последствие. Значения расписания
  // проходят ту же очистку, что и остальные факты, поэтому перенос строки в названии или сценарии
  // не может дорисовать строку, выглядящую как строка приложения.
  return buildApprovalMessage({
    actionLabel: lowerFirst(SCHEDULE_ACTIONS[actionName]!.action),
    consequence: SCHEDULE_CONSEQUENCES[actionName]!,
    facts: [
      ...approvalFact("Расписание", schedule.title),
      ...approvalFact("Назначение", schedule.userRequest),
      ...approvalFact("Периодичность", describeRecurrence(schedule.recurrence)),
      ...approvalFact("Следующий запуск", `${scheduleDate(schedule)} (${schedule.timezone})`),
      ...approvalFact("Сценарий", schedule.scenarioPrompt),
    ],
    // Отдельным блоком: предлагаемые значения обязаны быть визуально отделены от текущих, иначе
    // две строки «Сценарий:» — сохранённая и новая — читаются как одна.
    // `scheduleChanges` уже формирует строки «Метка: значение», поэтому им нужна только очистка.
    ...(changes.length === 0
      ? {}
      : { section: { lines: changes.map(sanitizeApprovalLine), title: "Изменения:" } }),
  });
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}


export function createTelegramApprovalPresenter(
  dependencies: ApprovalPresentationDependencies,
): TelegramApprovalPresenter {
  return async (request, ctx) => {
    const localized = localizeTelegramInputRequest(request);
    if(request.display === "confirmation" && request.action.toolName === "manage_space") {
      const input=manageSpaceInput.parse(request.action.input);
      if(input.action !== "set_role" || !dependencies.findSpaceMembers) throw new AppError("AGENT_APPROVAL_SUBJECT_NOT_FOUND","Изменение роли для подтверждения недоступно");
      const area=await dependencies.findSpaceMembers(input.areaRef!,ctx);
      const member=area.members.find(m=>m.memberRef===input.memberRef);
      if(!member || area.policyVersion!==input.policyVersion) throw new AppError("AGENT_SPACE_CONTEXT_STALE","Состав или права изменились. Прочитайте участников заново");
      const roles:Record<string,string>={manager:"Управляющий",adult:"Взрослый",helper:"Помощник (helper)",child:"Ребёнок (child)"};
      return {...localized,prompt:buildApprovalMessage({actionLabel:"изменить роль участника",
        facts:[...approvalFact("Пространство",area.title),...approvalFact("Участник",member.name),
          ...approvalFact("Сейчас",roles[member.role]??member.role),...approvalFact("Новая роль",roles[input.role!]!)],
        consequence:SPACE_ROLE_CONSEQUENCE})};
    }
    if (
      request.display === "confirmation" &&
      request.action.toolName === "manage_gmail_message"
    ) {
      const input = requireGmailMessageInput(request.action.input);
      const message = await dependencies.findGmailMessage(input.messageId, input.profileRef, ctx);
      return {
        ...localized,
        options: gmailMessageOptions(localized, input.action),
        prompt: gmailMessagePrompt(input.action, message),
      };
    }
    if (
      request.display === "confirmation" &&
      request.action.toolName === "execute_google_workspace"
    ) {
      return {
        ...localized,
        prompt: buildApprovalMessage({
          actionLabel: "изменение в Google Workspace",
          consequence: GOOGLE_WORKSPACE_CONSEQUENCE,
          facts: googleWorkspaceFacts(request.action.input),
        }),
      };
    }
    if (
      request.display !== "confirmation" ||
      request.action.toolName !== "manage_agent_schedule"
    ) return localized;

    const actionName = request.action.input.action;
    if (typeof actionName !== "string" || !SCHEDULE_ACTIONS[actionName]) {
      throw new AppError(
        "AGENT_APPROVAL_ACTION_INVALID",
        "Не удалось определить действие с агентным расписанием",
      );
    }
    if (actionName === "create") return localized;

    const id = request.action.input.id;
    if (typeof id !== "string" || !id) {
      throw new AppError(
        "AGENT_APPROVAL_SUBJECT_INVALID",
        "Не удалось определить агентное расписание для подтверждения",
      );
    }
    const schedule = await dependencies.findSchedule(requireAgentScheduleAuthorization(ctx), id);
    if (!schedule) {
      throw new AppError(
        "AGENT_APPROVAL_SUBJECT_NOT_FOUND",
        "Агентное расписание для подтверждения не найдено или больше недоступно",
      );
    }
    const changes = actionName === "update" ? scheduleChanges(request.action.input) : [];
    return {
      ...localized,
      prompt: schedulePrompt(actionName, schedule, changes),
    };
  };
}

export const presentTelegramApproval = createTelegramApprovalPresenter({
  findSpaceMembers:(areaRef,ctx)=>spaceRoleRepository.members(requireMemoryAuthorization(ctx),areaRef),
  findGmailMessage: loadGmailMessageApproval,
  findSchedule: (auth, id) => agentScheduleRepository.findById(auth, id),
});
