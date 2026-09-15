/**
 * Typed model-facing Google Workspace execution boundary.
 *
 * Exports:
 * - `execute_google_workspace`: reviewed argv execution with input-aware Eve HITL.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { AppError } from "../app-error.js";
import { isScheduledSession } from "../agent-schedules/scheduled-session.js";
import { classifyModelFacingGoogleWorkspaceCommand } from "../google-workspace/google-workspace-command-policy.js";
import {
  executeGoogleWorkspace,
} from "../google-workspace/google-workspace-executor.js";

export { createGoogleWorkspaceExecutor } from "../google-workspace/google-workspace-executor.js";

const commandSchema = z.object({
  argv: z.array(z.string().min(1).max(64 * 1024)).min(1).max(128).describe(
    "Точные аргументы gws без имени бинарника и shell quoting; API resource и method передаются отдельными элементами",
  ),
}).strict();

export default defineTool({
  approval: (ctx) => {
    try {
      const mutation = classifyModelFacingGoogleWorkspaceCommand(ctx.toolInput?.argv ?? []) === "mutation";
      if (mutation && isScheduledSession(ctx)) return {
        type: "denied",
        reason: "AGENT_GOOGLE_BACKGROUND_MUTATION_DENIED: В фоновом обзоре Google доступен только для чтения",
      };
      return mutation ? "user-approval" : "not-applicable";
    } catch (error) {
      return {
        type: "denied",
        reason: error instanceof AppError
          ? error.message
          : "AGENT_GOOGLE_WORKSPACE_COMMAND_FORBIDDEN: Команда отсутствует в allowlist",
      };
    }
  },
  description:
    "Выполнить разрешённую команду Google Workspace в текущем personal/family профиле. Передайте точный argv без `gws`. API resource и method всегда передавайте отдельными элементами, не объединяйте их через точку: например, `\"calendar\", \"events\", \"list\"`. Для schema используйте top-level argv `\"schema\", \"calendar.events.list\"`. Состояние отдельного Gmail-письма изменяй только через manage_gmail_message, передавая messageId и profileRef из результата чтения без изменений. Mutation автоматически требует подтверждения Eve со всеми аргументами и должна занимать не более 3000 символов в JSON-представлении. Файловые аргументы недоступны.",
  inputSchema: commandSchema,
  async execute(input, ctx) {
    const kind = classifyModelFacingGoogleWorkspaceCommand(input.argv);
    if (kind === "mutation" && isScheduledSession(ctx)) throw new AppError(
      "AGENT_GOOGLE_BACKGROUND_MUTATION_DENIED", "В фоновом обзоре Google доступен только для чтения",
    );
    return await executeGoogleWorkspace(input, ctx);
  },
});
