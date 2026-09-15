/**
 * Atomic model configuration controller tests.
 *
 * Constructs covered:
 * - `applyModelConfiguration`: validates, stages, preflights, commits, and activates one selection.
 * - Transaction recovery: restart failures restore exact previous bytes and reactivate them.
 * - Crash recovery: persisted transaction phases restore a matched previous file pair.
 * - Ambiguous recovery: failed rollback health produces a stable terminal error.
 * - Lock exclusion: a concurrent mutation cannot enter the transaction.
 * - `getModelConfigStatus` and `getCurrentModelSelection`: expose no credential values.
 */
import { describe, expect, it, vi } from "vitest";

import {
  applyModelConfiguration,
  getCurrentModelSelection,
  getModelConfigStatus,
} from "./controller.js";
import {
  createDependencies,
  paths,
  previousConfig,
  previousEnv,
  transactionJournalBytes,
  validConfig,
} from "./controller.test-support.js";

describe("atomic model configuration controller", () => {
  it("preflights staged candidates, commits exact config bytes, and preserves unrelated env bytes", async () => {
    const { dependencies, files } = createDependencies();

    await expect(applyModelConfiguration(dependencies, {
      configBytes: validConfig,
      groqApiKey: "new-groq-key",
      modelApiKey: "new-model-key",
    })).resolves.toEqual({ provider: "deepseek", primaryModelId: "deepseek-reasoner" });

    expect(dependencies.preflight).toHaveBeenCalledOnce();
    const candidatePaths = vi.mocked(dependencies.preflight).mock.calls[0]?.[0];
    expect(candidatePaths?.configPath).not.toBe(paths.configPath);
    expect(candidatePaths?.envPath).not.toBe(paths.envPath);
    expect(files.files.get(paths.configPath)).toEqual(validConfig);
    expect(files.files.get(paths.envPath)).toEqual(Buffer.from(
      "DATABASE_URL=postgres://local\r\nMODEL_API_KEY='new-model-key'\r\nBINARY=\xff\r\nGROQ_API_KEY='new-groq-key'\r\n",
      "latin1",
    ));
    expect(dependencies.restart).toHaveBeenCalledOnce();
    expect(dependencies.health).toHaveBeenCalledOnce();
    expect(files.locked).toBe(false);
    expect(files.files.has(paths.journalPath)).toBe(false);
  });

  it("recovers a crash after the first rename without restarting an inactive candidate", async () => {
    const candidateEnv = Buffer.from("MODEL_API_KEY='new-model-key'\n");
    const { dependencies, files } = createDependencies();
    files.files.set(paths.configPath, validConfig);
    files.files.set(paths.journalPath, transactionJournalBytes("prepared", candidateEnv));

    await expect(getCurrentModelSelection(dependencies)).resolves.toMatchObject({
      primaryModelId: "openrouter/previous",
      provider: "openrouter",
    });

    expect(files.files.get(paths.configPath)).toEqual(previousConfig);
    expect(files.files.get(paths.envPath)).toEqual(previousEnv);
    expect(files.files.has(paths.journalPath)).toBe(false);
    expect(dependencies.restart).not.toHaveBeenCalled();
    expect(dependencies.health).not.toHaveBeenCalled();
  });

  it("recovers a crash after both renames and before restart", async () => {
    const candidateEnv = Buffer.from("MODEL_API_KEY='new-model-key'\n");
    const { dependencies, files } = createDependencies();
    files.files.set(paths.configPath, validConfig);
    files.files.set(paths.envPath, candidateEnv);
    files.files.set(paths.journalPath, transactionJournalBytes("prepared", candidateEnv));

    await expect(getModelConfigStatus(dependencies)).resolves.toMatchObject({
      selection: { provider: "openrouter" },
    });

    expect(files.files.get(paths.configPath)).toEqual(previousConfig);
    expect(files.files.get(paths.envPath)).toEqual(previousEnv);
    expect(files.files.has(paths.journalPath)).toBe(false);
    expect(dependencies.restart).not.toHaveBeenCalled();
    expect(dependencies.health).not.toHaveBeenCalled();
  });

  it("recovers a crash after restart by restoring and activating the previous pair", async () => {
    const candidateEnv = Buffer.from("MODEL_API_KEY='new-model-key'\n");
    const { dependencies, files } = createDependencies();
    files.files.set(paths.configPath, validConfig);
    files.files.set(paths.envPath, candidateEnv);
    files.files.set(paths.journalPath, transactionJournalBytes("activation_started", candidateEnv));

    await expect(getCurrentModelSelection(dependencies)).resolves.toMatchObject({
      provider: "openrouter",
    });

    expect(files.files.get(paths.configPath)).toEqual(previousConfig);
    expect(files.files.get(paths.envPath)).toEqual(previousEnv);
    expect(dependencies.restart).toHaveBeenCalledOnce();
    expect(dependencies.health).toHaveBeenCalledOnce();
    expect(files.files.has(paths.journalPath)).toBe(false);
  });

  it("fails fast without touching files when a persisted journal is malformed", async () => {
    const { dependencies, files } = createDependencies();
    files.files.set(paths.journalPath, Buffer.from("{not-json"));

    await expect(getCurrentModelSelection(dependencies)).rejects.toThrow(
      "OSINARA_MODEL_CONFIG_JOURNAL_INVALID",
    );

    expect(files.files.get(paths.configPath)).toEqual(previousConfig);
    expect(files.files.get(paths.envPath)).toEqual(previousEnv);
    expect(files.files.has(paths.journalPath)).toBe(true);
    expect(dependencies.restart).not.toHaveBeenCalled();
  });

  it("fails ambiguous when active bytes do not match the trusted journal", async () => {
    const { dependencies, files } = createDependencies();
    files.files.set(paths.configPath, Buffer.from("out-of-band-config"));
    files.files.set(paths.journalPath, transactionJournalBytes("prepared"));

    await expect(getCurrentModelSelection(dependencies)).rejects.toThrow(
      "OSINARA_MODEL_CONFIG_STATE_AMBIGUOUS",
    );

    expect(files.files.get(paths.configPath)).toEqual(Buffer.from("out-of-band-config"));
    expect(files.files.has(paths.journalPath)).toBe(true);
    expect(dependencies.restart).not.toHaveBeenCalled();
  });

  it("rejects invalid schema before staging or invoking preflight", async () => {
    const { dependencies, files } = createDependencies();
    const invalid = Buffer.from(validConfig.toString().replace('"schemaVersion":4', '"schemaVersion":3'));

    await expect(applyModelConfiguration(dependencies, {
      configBytes: invalid,
      modelApiKey: "new-model-key",
    })).rejects.toThrow("OSINARA_MODEL_CONFIG_SCHEMA_INVALID");

    expect(files.operations.some((operation) => operation.startsWith("stage:"))).toBe(false);
    expect(dependencies.preflight).not.toHaveBeenCalled();
    expect(dependencies.restart).not.toHaveBeenCalled();
  });

  it("rejects duplicate target env entries before staging", async () => {
    const { dependencies, files } = createDependencies();
    files.files.set(paths.envPath, Buffer.from("MODEL_API_KEY=first\nMODEL_API_KEY=second\n"));

    await expect(applyModelConfiguration(dependencies, {
      configBytes: validConfig,
      modelApiKey: "new-model-key",
    })).rejects.toThrow("OSINARA_MODEL_CONFIG_ENV_DUPLICATE");

    expect(files.operations.some((operation) => operation.startsWith("stage:"))).toBe(false);
    expect(dependencies.preflight).not.toHaveBeenCalled();
  });

  it("does not retain credentials in validation or preflight errors", async () => {
    const secret = "credential-that-must-not-escape";
    const { dependencies } = createDependencies({
      preflight: vi.fn().mockRejectedValue(new Error(`provider rejected ${secret}`)),
    });

    const failure = await applyModelConfiguration(dependencies, {
      configBytes: validConfig,
      groqApiKey: `${secret}-groq`,
      modelApiKey: secret,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(secret);
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it("rolls back exact previous bytes and restarts the previous selection after restart failure", async () => {
    const restart = vi.fn()
      .mockRejectedValueOnce(new Error("restart failed"))
      .mockResolvedValueOnce(undefined);
    const { dependencies, files } = createDependencies({ restart });

    await expect(applyModelConfiguration(dependencies, {
      configBytes: validConfig,
      modelApiKey: "new-model-key",
    })).rejects.toThrow("OSINARA_MODEL_CONFIG_APPLY_FAILED");

    expect(files.files.get(paths.configPath)).toEqual(previousConfig);
    expect(files.files.get(paths.envPath)).toEqual(previousEnv);
    expect(restart).toHaveBeenCalledTimes(2);
    expect(dependencies.health).toHaveBeenCalledOnce();
  });

  it("reports an ambiguous state when rollback health also fails", async () => {
    const health = vi.fn()
      .mockRejectedValueOnce(new Error("new selection unhealthy"))
      .mockRejectedValueOnce(new Error("previous selection unhealthy"));
    const { dependencies, files } = createDependencies({ health });

    await expect(applyModelConfiguration(dependencies, {
      configBytes: validConfig,
      modelApiKey: "new-model-key",
    })).rejects.toThrow("OSINARA_MODEL_CONFIG_STATE_AMBIGUOUS");

    expect(files.files.get(paths.configPath)).toEqual(previousConfig);
    expect(files.files.get(paths.envPath)).toEqual(previousEnv);
    expect(dependencies.restart).toHaveBeenCalledTimes(2);
    expect(health).toHaveBeenCalledTimes(2);
  });

  it("does not let a lock release failure mask ambiguous rollback health", async () => {
    const health = vi.fn()
      .mockRejectedValueOnce(new Error("new selection unhealthy"))
      .mockRejectedValueOnce(new Error("previous selection unhealthy"));
    const { dependencies, files } = createDependencies({ health });
    files.releaseError = new Error("lock release failed");

    await expect(applyModelConfiguration(dependencies, {
      configBytes: validConfig,
      modelApiKey: "new-model-key",
    })).rejects.toThrow("OSINARA_MODEL_CONFIG_STATE_AMBIGUOUS");

    expect(files.files.has(paths.journalPath)).toBe(true);
    expect(files.locked).toBe(false);
  });

  it("reports ambiguity when journal removal durability cannot be confirmed", async () => {
    const { dependencies, files } = createDependencies();
    files.removeJournalError = new Error("directory fsync failed after unlink");

    await expect(applyModelConfiguration(dependencies, {
      configBytes: validConfig,
      modelApiKey: "new-model-key",
    })).rejects.toThrow("OSINARA_MODEL_CONFIG_STATE_AMBIGUOUS");

    expect(files.files.get(paths.configPath)).toEqual(validConfig);
    expect(files.files.has(paths.journalPath)).toBe(false);
    expect(dependencies.restart).toHaveBeenCalledOnce();
    expect(dependencies.health).toHaveBeenCalledOnce();
  });

  it("holds an exclusive lock for the complete activation transaction", async () => {
    let releaseRestart!: () => void;
    const restartGate = new Promise<void>((resolve) => { releaseRestart = resolve; });
    const { dependencies } = createDependencies({ restart: vi.fn(() => restartGate) });
    const first = applyModelConfiguration(dependencies, {
      configBytes: validConfig,
      modelApiKey: "first-key",
    });
    await vi.waitFor(() => expect(dependencies.restart).toHaveBeenCalledOnce());

    await expect(applyModelConfiguration(dependencies, {
      configBytes: validConfig,
      modelApiKey: "second-key",
    })).rejects.toThrow("OSINARA_MODEL_CONFIG_LOCKED");

    releaseRestart();
    await expect(first).resolves.toBeDefined();
  });

  it("returns CLI-safe status and current selection without credential values", async () => {
    const { dependencies } = createDependencies();

    await expect(getCurrentModelSelection(dependencies)).resolves.toEqual({
      primaryModelId: "openrouter/previous",
      provider: "openrouter",
      visionEnabled: false,
      voiceEnabled: false,
    });
    await expect(getModelConfigStatus(dependencies)).resolves.toEqual({
      groqApiKeyConfigured: false,
      modelApiKeyConfigured: true,
      selection: {
        primaryModelId: "openrouter/previous",
        provider: "openrouter",
        visionEnabled: false,
        voiceEnabled: false,
      },
    });
  });
});
