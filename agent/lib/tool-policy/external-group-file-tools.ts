/**
 * Execution-time boundary for Eve's external-group filesystem built-ins.
 *
 * Exports:
 * - `createExternalGroupFileTools`: testable same-name wrappers around Eve default tools.
 * - `EXTERNAL_GROUP_FILE_TOOLS`: production wrappers backed by live workspace authorization.
 *
 * Key constructs:
 * - Every execution resolves the current external registration before touching the sandbox.
 * - Model paths are canonical absolute paths under the exact `/workspace/group` root.
 * - Host-side component inspection rejects symlinks before Eve's native executor runs.
 */
import { type ToolContext, type ToolDefinition, defineTool } from "eve/tools";
import {
  glob as eveGlob,
  grep as eveGrep,
  readFile as eveReadFile,
  writeFile as eveWriteFile,
} from "eve/tools/defaults";

import { AppError } from "../app-error.js";
import { requireWorkspaceAuthorization } from "../workspaces/workspace-context.js";
import {
  type WorkspaceAuthorization,
  workspaceRepository,
} from "../workspaces/workspace-repository.js";
import {
  createScopedFileTools,
} from "./scoped-file-tools.js";

type AnyToolDefinition = ToolDefinition<any, any>;
type ExternalGroupFileToolName = "glob" | "grep" | "read_file" | "write_file";

interface ExternalGroupFileToolDependencies {
  authorize(auth: WorkspaceAuthorization): Promise<string>;
  defaults: Readonly<Record<ExternalGroupFileToolName, AnyToolDefinition>>;
}

function forbiddenPath(): AppError {
  return new AppError(
    "AGENT_GROUP_FILE_PATH_FORBIDDEN",
    "Файловая операция разрешена только внутри workspace текущей внешней группы",
  );
}

export function createExternalGroupFileTools(
  dependencies: ExternalGroupFileToolDependencies,
): Readonly<Record<ExternalGroupFileToolName, AnyToolDefinition>> {
  const workspaceTools = createScopedFileTools({
    authorize: async (auth) => [{
      hostRoot: await dependencies.authorize(auth),
      mountPoint: "group",
    }],
    defaultMountPoint: "group",
    defaults: dependencies.defaults,
    forbiddenPath,
  });
  return {
    glob: defineTool({
      ...workspaceTools.glob,
      description: "Найти файлы по glob-шаблону только внутри абсолютного path /workspace/group.",
    }),
    grep: defineTool({
      ...workspaceTools.grep,
      description: "Найти текст только внутри файлов под абсолютным path /workspace/group.",
    }),
    read_file: defineTool({
      ...workspaceTools.read_file,
      description: "Прочитать файл только по абсолютному filePath внутри /workspace/group.",
    }),
    write_file: defineTool({
      ...workspaceTools.write_file,
      description: "Создать или изменить файл только по абсолютному filePath внутри /workspace/group.",
    }),
  };
}

export const EXTERNAL_GROUP_FILE_TOOLS = createExternalGroupFileTools({
  authorize: async (auth) => await workspaceRepository.externalGroupRoot(auth),
  defaults: {
    glob: eveGlob,
    grep: eveGrep,
    read_file: eveReadFile,
    write_file: eveWriteFile,
  },
});
