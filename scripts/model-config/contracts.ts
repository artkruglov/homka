/**
 * Atomic model configuration controller contracts.
 *
 * Exports:
 * - `ModelConfigPaths`: dependency-injected managed, journal, and lock paths.
 * - `StagedFile` and `ModelConfigFileStore`: durable same-directory file transaction boundary.
 * - `ModelConfigDependencies`: privilege, preflight, activation, and health dependencies.
 * - `ApplyModelConfigurationInput`: exact config bytes and required/optional credentials.
 * - `ModelSelection` and `ModelConfigStatus`: secret-free CLI response contracts.
 */
export interface ModelConfigPaths {
  readonly configPath: string;
  readonly envPath: string;
  readonly journalPath: string;
  readonly lockPath: string;
}

export interface StagedFile {
  readonly destinationPath: string;
  readonly temporaryPath: string;
}

export interface ModelConfigFileStore {
  acquireLock(): Promise<() => Promise<void>>;
  assertManagedFile(path: string, mode: number): Promise<void>;
  commit(staged: StagedFile): Promise<void>;
  discard(staged: StagedFile): Promise<void>;
  read(path: string): Promise<Buffer>;
  readJournal(): Promise<Buffer | null>;
  removeJournal(): Promise<void>;
  stage(destinationPath: string, bytes: Buffer, mode: number): Promise<StagedFile>;
  writeJournal(bytes: Buffer): Promise<void>;
}

export interface ModelConfigCandidatePaths {
  readonly configPath: string;
  readonly envPath: string;
}

export interface ModelConfigDependencies {
  readonly assertRoot: () => Promise<void> | void;
  readonly files: ModelConfigFileStore;
  readonly health: () => Promise<void>;
  readonly paths: ModelConfigPaths;
  readonly preflight: (candidatePaths: ModelConfigCandidatePaths) => Promise<void>;
  readonly restart: () => Promise<void>;
}

export interface ApplyModelConfigurationInput {
  readonly configBytes: Buffer;
  readonly groqApiKey?: string;
  readonly modelApiKey: string;
}

export interface ModelSelection {
  readonly primaryModelId: string;
  readonly provider: string;
  readonly visionEnabled: boolean;
  readonly voiceEnabled: boolean;
}

export interface ModelConfigStatus {
  readonly groqApiKeyConfigured: boolean;
  readonly modelApiKeyConfigured: boolean;
  readonly selection: ModelSelection;
}
