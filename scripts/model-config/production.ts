/**
 * Production wiring for the root-owned model configuration controller.
 *
 * Exports:
 * - `PRODUCTION_MODEL_CONFIG_PATHS`: canonical host paths, journal, and lock location.
 * - `createProductionModelConfigDependencies`: binds host files to injected service operations.
 */
import type { ModelConfigDependencies, ModelConfigPaths } from "./contracts.js";
import { modelConfigError } from "./errors.js";
import { RootModelConfigFileStore } from "./root-file-store.js";

export const PRODUCTION_MODEL_CONFIG_PATHS: ModelConfigPaths = Object.freeze({
  configPath: "/opt/osinara/agent-model-providers.json",
  envPath: "/opt/osinara/.env",
  journalPath: "/opt/osinara/.model-config.transaction",
  lockPath: "/opt/osinara/.model-config.lock",
});

export function createProductionModelConfigDependencies(operations: Pick<
  ModelConfigDependencies,
  "health" | "preflight" | "restart"
>): ModelConfigDependencies {
  return {
    assertRoot: () => {
      if (process.getuid?.() !== 0 || process.getgid?.() !== 0) {
        throw modelConfigError(
          "OSINARA_MODEL_CONFIG_ROOT_REQUIRED",
          "Изменение конфигурации модели разрешено только пользователю root",
        );
      }
    },
    files: new RootModelConfigFileStore(PRODUCTION_MODEL_CONFIG_PATHS),
    health: operations.health,
    paths: PRODUCTION_MODEL_CONFIG_PATHS,
    preflight: operations.preflight,
    restart: operations.restart,
  };
}
