/**
 * Durable model configuration transaction journal.
 *
 * Exports:
 * - `ModelConfigTransactionJournal`: exact previous/candidate bytes and durable activation phase.
 * - `createTransactionJournal`: creates a versioned journal from trusted in-memory bytes.
 * - `parseTransactionJournal`: strictly validates and decodes persisted journal bytes.
 * - `serializeTransactionJournal`: emits deterministic bytes for durable persistence.
 * - `withJournalPhase`: advances a journal without changing its byte pairs.
 */
import { createHash } from "node:crypto";

import { modelConfigError } from "./errors.js";

const JOURNAL_SCHEMA_VERSION = 1;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export type ModelConfigTransactionPhase =
  | "activation_started"
  | "prepared"
  | "rollback_started";

interface JournalBytes {
  readonly base64: string;
  readonly sha256: string;
}

interface JournalPair {
  readonly config: JournalBytes;
  readonly env: JournalBytes;
}

export interface ModelConfigTransactionJournal {
  readonly candidateConfig: Buffer;
  readonly candidateEnv: Buffer;
  readonly phase: ModelConfigTransactionPhase;
  readonly previousConfig: Buffer;
  readonly previousEnv: Buffer;
}

function invalidJournal(): never {
  throw modelConfigError(
    "OSINARA_MODEL_CONFIG_JOURNAL_INVALID",
    "Журнал транзакции конфигурации повреждён или имеет неподдерживаемый формат; требуется проверка оператором",
  );
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeBytes(value: unknown): Buffer {
  if (!isRecord(value) || !hasExactKeys(value, ["base64", "sha256"])) invalidJournal();
  if (
    typeof value.base64 !== "string" ||
    typeof value.sha256 !== "string" ||
    !BASE64_PATTERN.test(value.base64) ||
    !SHA256_PATTERN.test(value.sha256)
  ) {
    invalidJournal();
  }

  // Canonical base64 plus an independent digest detects truncation and non-canonical decoding.
  const bytes = Buffer.from(value.base64, "base64");
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (bytes.toString("base64") !== value.base64 || digest !== value.sha256) invalidJournal();
  return bytes;
}

function decodePair(value: unknown): readonly [Buffer, Buffer] {
  if (!isRecord(value) || !hasExactKeys(value, ["config", "env"])) invalidJournal();
  return [decodeBytes(value.config), decodeBytes(value.env)];
}

function encodeBytes(bytes: Buffer): JournalBytes {
  return {
    base64: bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function createTransactionJournal(
  previousConfig: Buffer,
  previousEnv: Buffer,
  candidateConfig: Buffer,
  candidateEnv: Buffer,
): ModelConfigTransactionJournal {
  return {
    candidateConfig: Buffer.from(candidateConfig),
    candidateEnv: Buffer.from(candidateEnv),
    phase: "prepared",
    previousConfig: Buffer.from(previousConfig),
    previousEnv: Buffer.from(previousEnv),
  };
}

export function parseTransactionJournal(bytes: Buffer): ModelConfigTransactionJournal {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    invalidJournal();
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["candidate", "phase", "previous", "schemaVersion"]) ||
    value.schemaVersion !== JOURNAL_SCHEMA_VERSION ||
    (value.phase !== "prepared" &&
      value.phase !== "activation_started" &&
      value.phase !== "rollback_started")
  ) {
    invalidJournal();
  }

  // Decode all four values only after the outer shape and phase are proven exact.
  const [candidateConfig, candidateEnv] = decodePair(value.candidate);
  const [previousConfig, previousEnv] = decodePair(value.previous);
  return { candidateConfig, candidateEnv, phase: value.phase, previousConfig, previousEnv };
}

export function serializeTransactionJournal(journal: ModelConfigTransactionJournal): Buffer {
  const candidate: JournalPair = {
    config: encodeBytes(journal.candidateConfig),
    env: encodeBytes(journal.candidateEnv),
  };
  const previous: JournalPair = {
    config: encodeBytes(journal.previousConfig),
    env: encodeBytes(journal.previousEnv),
  };
  return Buffer.from(JSON.stringify({
    candidate,
    phase: journal.phase,
    previous,
    schemaVersion: JOURNAL_SCHEMA_VERSION,
  }));
}

export function withJournalPhase(
  journal: ModelConfigTransactionJournal,
  phase: ModelConfigTransactionPhase,
): ModelConfigTransactionJournal {
  return { ...journal, phase };
}
