/**
 * In-memory support for model configuration controller tests.
 *
 * Exports:
 * - `paths`, `validConfig`, `previousConfig`, and `previousEnv`: exact transaction fixtures.
 * - `transactionJournalBytes`: persisted crash-state fixture with valid checksums.
 * - `MemoryFileStore`: deterministic file, journal, and lock test double.
 * - `createDependencies`: controller dependencies with injectable activation operations.
 */
import { createHash } from "node:crypto";

import { vi } from "vitest";

import type {
  ModelConfigDependencies,
  ModelConfigFileStore,
  ModelConfigPaths,
  StagedFile,
} from "./contracts.js";

export const paths: ModelConfigPaths = {
  configPath: "/srv/osinara/agent-model-providers.json",
  envPath: "/srv/osinara/.env",
  journalPath: "/srv/osinara/.model-config.transaction",
  lockPath: "/srv/osinara/.model-config.lock",
};

export const validConfig = Buffer.from(JSON.stringify({
  agent: {
    models: {
      primary: { contextWindowTokens: 128_000, id: "deepseek-reasoner", maxOutputTokens: 16_000 },
      vision: { supportsImageInput: false },
    },
    transport: {
      baseUrl: "https://api.deepseek.com",
      protocol: "openai-chat-completions",
      providerName: "deepseek",
      reasoning: { effort: "high", format: "deepseek", type: "effort" },
    },
  },
  provider: "deepseek",
  schemaVersion: 4,
  voice: { enabled: true, transcriptionModelId: "whisper-large-v3-turbo" },
}));

export const previousConfig = Buffer.from(JSON.stringify({
  agent: {
    models: {
      primary: { contextWindowTokens: 128_000, id: "openrouter/previous", maxOutputTokens: 8_192 },
      vision: { supportsImageInput: false },
    },
    transport: {
      baseUrl: "https://openrouter.ai/api/v1",
      protocol: "openai-chat-completions",
      providerName: "openrouter",
      reasoning: null,
    },
  },
  provider: "openrouter",
  schemaVersion: 4,
  voice: { enabled: false },
}));

export const previousEnv = Buffer.from(
  "DATABASE_URL=postgres://local\r\nMODEL_API_KEY=old-key\r\nBINARY=\xff\r\n",
  "latin1",
);

type TestJournalPhase = "activation_started" | "prepared" | "rollback_started";

function encodedJournalBytes(bytes: Buffer): { readonly base64: string; readonly sha256: string } {
  return {
    base64: bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function transactionJournalBytes(
  phase: TestJournalPhase,
  candidateEnv = Buffer.from("MODEL_API_KEY='new-model-key'\n"),
): Buffer {
  return Buffer.from(JSON.stringify({
    candidate: {
      config: encodedJournalBytes(validConfig),
      env: encodedJournalBytes(candidateEnv),
    },
    phase,
    previous: {
      config: encodedJournalBytes(previousConfig),
      env: encodedJournalBytes(previousEnv),
    },
    schemaVersion: 1,
  }));
}

export class MemoryFileStore implements ModelConfigFileStore {
  public readonly files = new Map<string, Buffer>([
    [paths.configPath, previousConfig],
    [paths.envPath, previousEnv],
  ]);
  public readonly operations: string[] = [];
  public locked = false;
  public releaseError: Error | undefined;
  public removeJournalError: Error | undefined;
  private stageSequence = 0;

  public async assertManagedFile(path: string, mode: number): Promise<void> {
    this.operations.push(`assert:${path}:${mode.toString(8)}`);
    if (!this.files.has(path)) throw new Error(`missing managed file: ${path}`);
  }

  public async acquireLock(): Promise<() => Promise<void>> {
    if (this.locked) throw new Error("OSINARA_MODEL_CONFIG_LOCKED: controller is busy");
    this.locked = true;
    this.operations.push("lock");
    return async () => {
      this.locked = false;
      this.operations.push("unlock");
      if (this.releaseError) throw this.releaseError;
    };
  }

  public async commit(staged: StagedFile): Promise<void> {
    const bytes = this.files.get(staged.temporaryPath);
    if (!bytes) throw new Error("missing staged file");
    this.files.set(staged.destinationPath, bytes);
    this.files.delete(staged.temporaryPath);
    this.operations.push(`commit:${staged.destinationPath}`);
  }

  public async discard(staged: StagedFile): Promise<void> {
    this.files.delete(staged.temporaryPath);
    this.operations.push(`discard:${staged.temporaryPath}`);
  }

  public async read(path: string): Promise<Buffer> {
    const bytes = this.files.get(path);
    if (!bytes) throw new Error(`missing file: ${path}`);
    this.operations.push(`read:${path}`);
    return Buffer.from(bytes);
  }

  public async readJournal(): Promise<Buffer | null> {
    this.operations.push("journal:read");
    const bytes = this.files.get(paths.journalPath);
    return bytes ? Buffer.from(bytes) : null;
  }

  public async removeJournal(): Promise<void> {
    this.files.delete(paths.journalPath);
    this.operations.push("journal:remove");
    if (this.removeJournalError) throw this.removeJournalError;
  }

  public async stage(destinationPath: string, bytes: Buffer, mode: number): Promise<StagedFile> {
    const temporaryPath = `${destinationPath}.stage-${++this.stageSequence}`;
    this.files.set(temporaryPath, Buffer.from(bytes));
    this.operations.push(`stage:${destinationPath}:${mode.toString(8)}`);
    return { destinationPath, temporaryPath };
  }

  public async writeJournal(bytes: Buffer): Promise<void> {
    this.files.set(paths.journalPath, Buffer.from(bytes));
    this.operations.push("journal:write");
  }
}

export function createDependencies(overrides: Partial<ModelConfigDependencies> = {}) {
  const files = new MemoryFileStore();
  const dependencies: ModelConfigDependencies = {
    assertRoot: vi.fn().mockResolvedValue(undefined),
    files,
    health: vi.fn().mockResolvedValue(undefined),
    paths,
    preflight: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return { dependencies, files };
}
