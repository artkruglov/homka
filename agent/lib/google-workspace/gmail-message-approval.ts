/**
 * Trusted Gmail message metadata used only to explain a pending state change.
 *
 * The provider read is bound to the same verified profile and immutable message ID as execution.
 */
import type { SessionContext } from "eve/context";
import { z } from "zod";

import { AppError } from "../app-error.js";
import type { GoogleIntegrationAuthorization, GoogleIntegrationScope } from "./google-integration-contract.js";
import { runGoogleWorkspaceCommand } from "./google-workspace-command-runner.js";
import { resolveGoogleWorkspaceAuthorization } from "./google-workspace-context.js";
import { withAuthorizedGoogleWorkspaceExecution } from "./google-workspace-executor.js";
import type { GoogleWorkspaceExecutionProfile } from "./google-workspace-executor.js";

const GMAIL_SNIPPET_MAX_CHARACTERS = 240;

const gmailMessageResponseSchema = z.looseObject({
  id: z.string().min(1),
  payload: z.looseObject({
    headers: z.array(z.looseObject({
      name: z.string(),
      value: z.string(),
    })).optional(),
  }).optional(),
  snippet: z.string().optional(),
});

export interface GmailMessageApprovalSubject {
  date: string | null;
  from: string | null;
  id: string;
  profileDisplayName: string;
  profileRef: string;
  scope: GoogleIntegrationScope;
  snippet: string | null;
  subject: string | null;
}

interface GmailMessageApprovalDependencies {
  resolveAuthorization(
    ctx: Pick<SessionContext, "session">,
  ): Promise<GoogleIntegrationAuthorization>;
  run(
    argv: readonly string[],
    kind: "read",
    auth: GoogleIntegrationAuthorization,
    accessToken: string,
    ctx: { abortSignal: AbortSignal },
  ): ReturnType<typeof runGoogleWorkspaceCommand>;
  withAuthorizedExecution<T>(
    auth: GoogleIntegrationAuthorization,
    operation: (
      accessToken: string,
      profile: GoogleWorkspaceExecutionProfile,
    ) => Promise<T>,
  ): Promise<T>;
}

function readable(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
  return normalized || null;
}

function boundedSnippet(value: string | undefined): string | null {
  const normalized = readable(value);
  if (normalized === null || normalized.length <= GMAIL_SNIPPET_MAX_CHARACTERS) return normalized;
  return `${normalized.slice(0, GMAIL_SNIPPET_MAX_CHARACTERS - 1).trimEnd()}…`;
}

function responseSubject(
  requestedId: string,
  profile: GoogleWorkspaceExecutionProfile,
  scope: GoogleIntegrationScope,
  stdout: string,
): GmailMessageApprovalSubject {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch (cause) {
    const error = new AppError(
      "AGENT_GMAIL_APPROVAL_SUBJECT_INVALID",
      "Gmail вернул некорректные сведения о письме. Действие не выполнено",
    );
    error.cause = cause;
    throw error;
  }
  const parsed = gmailMessageResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new AppError(
      "AGENT_GMAIL_APPROVAL_SUBJECT_INVALID",
      "Gmail вернул неполные сведения о письме. Действие не выполнено",
    );
  }
  if (parsed.data.id !== requestedId) {
    throw new AppError(
      "AGENT_GMAIL_APPROVAL_SUBJECT_MISMATCH",
      "Gmail вернул другое письмо. Действие остановлено",
    );
  }
  const headers = parsed.data.payload?.headers ?? [];
  const header = (name: string) => readable(
    headers.find((item) => item.name.toLowerCase() === name)?.value,
  );
  return {
    date: header("date"),
    from: header("from"),
    id: parsed.data.id,
    profileDisplayName: profile.displayName,
    profileRef: profile.profileRef,
    scope,
    snippet: boundedSnippet(parsed.data.snippet),
    subject: header("subject"),
  };
}

export function createGmailMessageApprovalLoader(
  dependencies: GmailMessageApprovalDependencies,
) {
  return async function loadGmailMessageApproval(
    messageId: string,
    expectedProfileRef: string,
    ctx: Pick<SessionContext, "session">,
  ): Promise<GmailMessageApprovalSubject> {
    const auth = await dependencies.resolveAuthorization(ctx);
    return await dependencies.withAuthorizedExecution(auth, async (accessToken, profile) => {
      if (profile.profileRef !== expectedProfileRef) {
        throw new AppError(
          "AGENT_GOOGLE_WORKSPACE_PROFILE_CHANGED",
          "Подключённый Google-профиль изменился после выбора письма. Повторите запрос",
        );
      }
      const result = await dependencies.run([
        "gmail",
        "users",
        "messages",
        "get",
        "--params",
        JSON.stringify({
          format: "metadata",
          id: messageId,
          metadataHeaders: ["From", "Subject", "Date"],
          userId: "me",
        }),
      ], "read", auth, accessToken, { abortSignal: new AbortController().signal });
      return responseSubject(messageId, profile, auth.scope, result.stdout);
    });
  };
}

export const loadGmailMessageApproval = createGmailMessageApprovalLoader({
  resolveAuthorization: resolveGoogleWorkspaceAuthorization,
  run: runGoogleWorkspaceCommand,
  withAuthorizedExecution: withAuthorizedGoogleWorkspaceExecution,
});
