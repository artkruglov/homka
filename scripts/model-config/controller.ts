/**
 * Root-owned atomic model configuration transaction.
 *
 * Exports:
 * - `applyModelConfiguration`: validates, preflights, activates, and rolls back one configuration.
 * - `getCurrentModelSelection`: returns the active provider/model selection for CLI output.
 * - `getModelConfigStatus`: returns selection and credential presence without secret values.
 *
 * Key constructs:
 * - Durable recovery restores journaled previous bytes before every command.
 * - Lock execution preserves the primary transaction error over cleanup failures.
 */
import type {
  ApplyModelConfigurationInput,
  ModelConfigDependencies,
  ModelConfigStatus,
  ModelSelection,
  StagedFile,
} from "./contracts.js";
import { buildModelEnvironment, readModelCredentialPresence } from "./environment.js";
import { ModelConfigError, modelConfigError } from "./errors.js";
import { parseModelProviderConfigBytes, toModelSelection } from "./schema.js";
import {
  createTransactionJournal,
  parseTransactionJournal,
  serializeTransactionJournal,
  withJournalPhase,
} from "./transaction-journal.js";
import type { ModelConfigTransactionJournal } from "./transaction-journal.js";

const CONFIG_MODE = 0o644;
const ENV_MODE = 0o600;

async function assertManagedState(dependencies: ModelConfigDependencies): Promise<void> {
  await dependencies.assertRoot();
  await dependencies.files.assertManagedFile(dependencies.paths.configPath, CONFIG_MODE);
  await dependencies.files.assertManagedFile(dependencies.paths.envPath, ENV_MODE);
}

async function stagePair(
  dependencies: ModelConfigDependencies,
  configBytes: Buffer,
  envBytes: Buffer,
): Promise<readonly [StagedFile, StagedFile]> {
  const config = await dependencies.files.stage(dependencies.paths.configPath, configBytes, CONFIG_MODE);
  try {
    const env = await dependencies.files.stage(dependencies.paths.envPath, envBytes, ENV_MODE);
    return [config, env];
  } catch (error) {
    await dependencies.files.discard(config);
    throw error;
  }
}

async function discardPair(
  dependencies: ModelConfigDependencies,
  staged: readonly StagedFile[],
): Promise<void> {
  await Promise.all(staged.map((file) => dependencies.files.discard(file)));
}

async function commitPair(
  dependencies: ModelConfigDependencies,
  staged: readonly [StagedFile, StagedFile],
): Promise<void> {
  await dependencies.files.commit(staged[0]);
  await dependencies.files.commit(staged[1]);
}

async function restorePrevious(
  dependencies: ModelConfigDependencies,
  configBytes: Buffer,
  envBytes: Buffer,
  reactivate: boolean,
): Promise<void> {
  const rollback = await stagePair(dependencies, configBytes, envBytes);
  try {
    await commitPair(dependencies, rollback);
  } catch (error) {
    // Cleanup is best-effort here; the durable journal remains the source of recovery truth.
    await Promise.allSettled(rollback.map((file) => dependencies.files.discard(file)));
    throw error;
  }
  if (reactivate) {
    await dependencies.restart();
    await dependencies.health();
  }
}

function applyFailure(): ModelConfigError {
  return modelConfigError(
    "OSINARA_MODEL_CONFIG_APPLY_FAILED",
    "Новая конфигурация не была активирована; предыдущая конфигурация восстановлена",
  );
}

function ambiguousFailure(): ModelConfigError {
  return modelConfigError(
    "OSINARA_MODEL_CONFIG_STATE_AMBIGUOUS",
    "Не удалось подтвердить работоспособность после отката; состояние сервиса неоднозначно и требует проверки оператором",
  );
}

function bytesMatch(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && left.equals(right);
}

function pairMemberMatches(
  active: Buffer,
  previous: Buffer,
  candidate: Buffer,
): boolean {
  return bytesMatch(active, previous) || bytesMatch(active, candidate);
}

async function recoverPendingTransaction(dependencies: ModelConfigDependencies): Promise<void> {
  const journalBytes = await dependencies.files.readJournal();
  if (journalBytes === null) return;
  const journal = parseTransactionJournal(journalBytes);
  const [activeConfig, activeEnv] = await Promise.all([
    dependencies.files.read(dependencies.paths.configPath),
    dependencies.files.read(dependencies.paths.envPath),
  ]);

  // Unknown bytes imply an out-of-band write; overwriting them would destroy evidence.
  if (
    !pairMemberMatches(activeConfig, journal.previousConfig, journal.candidateConfig) ||
    !pairMemberMatches(activeEnv, journal.previousEnv, journal.candidateEnv)
  ) {
    throw ambiguousFailure();
  }

  const activationMayHaveBegun = journal.phase !== "prepared";
  let recoveryJournal = journal;
  if (activationMayHaveBegun && journal.phase !== "rollback_started") {
    recoveryJournal = withJournalPhase(journal, "rollback_started");
    await dependencies.files.writeJournal(serializeTransactionJournal(recoveryJournal));
  }

  // The journal remains until both exact files and any required service activation are proven.
  try {
    await restorePrevious(
      dependencies,
      recoveryJournal.previousConfig,
      recoveryJournal.previousEnv,
      activationMayHaveBegun,
    );
    await dependencies.files.removeJournal();
  } catch {
    throw ambiguousFailure();
  }
}

async function runUnderRecoveredLock<T>(
  dependencies: ModelConfigDependencies,
  operation: () => Promise<T>,
): Promise<T> {
  const release = await dependencies.files.acquireLock();
  let primaryFailure: unknown;
  try {
    await assertManagedState(dependencies);
    await recoverPendingTransaction(dependencies);
    await assertManagedState(dependencies);
    return await operation();
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      await release();
    } catch (releaseError) {
      // Lock cleanup is actionable only when no more important transaction failure exists.
      if (primaryFailure === undefined) throw releaseError;
    }
  }
}

async function persistPhase(
  dependencies: ModelConfigDependencies,
  journal: ModelConfigTransactionJournal,
): Promise<void> {
  await dependencies.files.writeJournal(serializeTransactionJournal(journal));
}

export async function applyModelConfiguration(
  dependencies: ModelConfigDependencies,
  input: ApplyModelConfigurationInput,
): Promise<Pick<ModelSelection, "primaryModelId" | "provider">> {
  await assertManagedState(dependencies);
  return runUnderRecoveredLock(dependencies, async () => {
    const parsed = parseModelProviderConfigBytes(input.configBytes);
    const previousConfig = await dependencies.files.read(dependencies.paths.configPath);
    const previousEnv = await dependencies.files.read(dependencies.paths.envPath);
    const candidateEnv = buildModelEnvironment(previousEnv, input);
    const staged = await stagePair(dependencies, input.configBytes, candidateEnv);

    try {
      await dependencies.preflight({
        configPath: staged[0].temporaryPath,
        envPath: staged[1].temporaryPath,
      });
    } catch {
      await discardPair(dependencies, staged);
      throw modelConfigError(
        "OSINARA_MODEL_CONFIG_PREFLIGHT_FAILED",
        "Предварительная проверка новой конфигурации не пройдена; активные файлы не изменены",
      );
    }

    const journal = createTransactionJournal(
      previousConfig,
      previousEnv,
      input.configBytes,
      candidateEnv,
    );
    try {
      // A durable prepared journal precedes the first rename, closing the split-pair crash window.
      await persistPhase(dependencies, journal);
      await commitPair(dependencies, staged);
      await persistPhase(dependencies, withJournalPhase(journal, "activation_started"));
      await dependencies.restart();
      await dependencies.health();
    } catch {
      let discardFailure: unknown;
      try {
        await discardPair(dependencies, staged);
      } catch (error) {
        discardFailure = error;
      }
      try {
        await recoverPendingTransaction(dependencies);
      } catch {
        throw ambiguousFailure();
      }
      if (discardFailure !== undefined) {
        throw modelConfigError(
          "OSINARA_MODEL_CONFIG_CLEANUP_FAILED",
          "Предыдущая конфигурация восстановлена, но временные файлы не удалось удалить; требуется проверка оператором",
        );
      }
      throw applyFailure();
    }

    // A failed unlink/fsync can mean either durable journal state; never claim a definite outcome.
    try {
      await dependencies.files.removeJournal();
    } catch {
      throw ambiguousFailure();
    }
    return { primaryModelId: parsed.agent.models.primary.id, provider: parsed.provider };
  });
}

export async function getCurrentModelSelection(
  dependencies: ModelConfigDependencies,
): Promise<ModelSelection> {
  await assertManagedState(dependencies);
  return runUnderRecoveredLock(dependencies, async () => {
    const config = parseModelProviderConfigBytes(
      await dependencies.files.read(dependencies.paths.configPath),
    );
    return toModelSelection(config);
  });
}

export async function getModelConfigStatus(
  dependencies: ModelConfigDependencies,
): Promise<ModelConfigStatus> {
  await assertManagedState(dependencies);
  return runUnderRecoveredLock(dependencies, async () => {
    const [configBytes, envBytes] = await Promise.all([
      dependencies.files.read(dependencies.paths.configPath),
      dependencies.files.read(dependencies.paths.envPath),
    ]);
    return {
      ...readModelCredentialPresence(envBytes),
      selection: toModelSelection(parseModelProviderConfigBytes(configBytes)),
    };
  });
}
