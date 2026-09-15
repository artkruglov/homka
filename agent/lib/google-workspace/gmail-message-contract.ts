/** Structured contract for Gmail single-message state changes. */
import { z } from "zod";

import { AppError } from "../app-error.js";

function isVisibleMessageId(value: string): boolean {
  return [...value].every((character) =>
    character.trim() !== "" && !/[\p{Cc}\p{Cf}]/u.test(character)
  );
}

export const gmailMessageInputSchema = z.object({
  action: z.enum(["trash", "delete", "restore", "mark_read", "mark_unread"]).describe(
    "Точное изменение состояния одного Gmail-письма",
  ),
  messageId: z.string().min(1).max(512).refine(
    isVisibleMessageId,
    "messageId должен состоять из видимых символов без пробелов",
  ).describe("Точный Gmail message ID из результата чтения или поиска"),
  profileRef: z.string().min(1).max(512).refine(
    isVisibleMessageId,
    "profileRef должен состоять из видимых символов без пробелов",
  ).describe("Точная ссылка на Google-профиль из результата чтения Gmail"),
}).strict();

export type GmailMessageInput = z.infer<typeof gmailMessageInputSchema>;

export function requireGmailMessageInput(input: unknown): GmailMessageInput {
  const parsed = gmailMessageInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(
      "AGENT_GMAIL_MESSAGE_INPUT_INVALID",
      "Не удалось определить письмо, профиль или действие Gmail. Повторите запрос с точными messageId и profileRef",
    );
  }
  return parsed.data;
}

export function gmailMessageMutationArgv(input: GmailMessageInput): string[] {
  const routeAction = input.action === "restore" ? "untrash" : input.action;
  const route = [
    "gmail",
    "users",
    "messages",
    routeAction === "mark_read" || routeAction === "mark_unread" ? "modify" : routeAction,
    "--params",
    JSON.stringify({ userId: "me", id: input.messageId }),
  ];
  if (input.action === "mark_read") {
    return [...route, "--json", JSON.stringify({ removeLabelIds: ["UNREAD"] })];
  }
  if (input.action === "mark_unread") {
    return [...route, "--json", JSON.stringify({ addLabelIds: ["UNREAD"] })];
  }
  return route;
}
