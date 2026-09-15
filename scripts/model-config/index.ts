/**
 * Public API for root-owned model configuration management.
 *
 * Exports:
 * - Controller apply, status, and current-selection functions.
 * - Production dependency factory and canonical paths.
 * - Public request, response, dependency, and error contracts.
 */
export {
  applyModelConfiguration,
  getCurrentModelSelection,
  getModelConfigStatus,
} from "./controller.js";
export type {
  ApplyModelConfigurationInput,
  ModelConfigCandidatePaths,
  ModelConfigDependencies,
  ModelConfigFileStore,
  ModelConfigPaths,
  ModelConfigStatus,
  ModelSelection,
  StagedFile,
} from "./contracts.js";
export { ModelConfigError } from "./errors.js";
export {
  createProductionModelConfigDependencies,
  PRODUCTION_MODEL_CONFIG_PATHS,
} from "./production.js";
