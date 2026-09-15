/**
 * Strict opaque cursor helpers for stable PostgreSQL keyset pagination.
 *
 * Exports:
 * - `decodeDateUuidCursor` / `encodeDateUuidCursor`: timestamp plus UUID cursor codec.
 * - `decodeDateBigintCursor` / `encodeDateBigintCursor`: timestamp plus positive bigint codec.
 * - `decodeBigintUuidCursor` / `encodeBigintUuidCursor`: positive bigint plus UUID cursor codec.
 * - `paginationFilterDigest`: stable binding for the filters that define one result set.
 */
import { createHash } from "node:crypto";

import { AppError } from "./app-error.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const POSITIVE_BIGINT_PATTERN = /^[1-9]\d*$/u;
const FILTER_DIGEST_PATTERN = /^[0-9a-f]{32}$/u;

function invalidCursor(code: string, message: string): never {
  throw new AppError(code, message);
}

export function paginationFilterDigest(values: readonly (string | null)[]): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 32);
}

function requireBinding(
  actual: string | undefined,
  expected: string | undefined,
  code: string,
  message: string,
): void {
  if (actual !== expected || (actual !== undefined && !FILTER_DIGEST_PATTERN.test(actual))) {
    invalidCursor(code, message);
  }
}

export function decodeDateUuidCursor(
  value: string | undefined,
  code: string,
  message: string,
  binding?: string,
): { id: string; timestamp: Date } | null {
  if (value === undefined) return null;
  const [rawTimestamp, id, cursorBinding, extra] = value.split("|");
  const timestamp = new Date(rawTimestamp ?? "");
  if (extra !== undefined || !id || !UUID_PATTERN.test(id) || Number.isNaN(timestamp.getTime())) {
    invalidCursor(code, message);
  }
  requireBinding(cursorBinding, binding, code, message);
  return { id, timestamp };
}

export function encodeDateUuidCursor(timestamp: Date, id: string, binding?: string): string {
  return `${timestamp.toISOString()}|${id}${binding === undefined ? "" : `|${binding}`}`;
}

export function decodeDateBigintCursor(
  value: string | undefined,
  code: string,
  message: string,
  binding?: string,
): { id: string; timestamp: Date } | null {
  if (value === undefined) return null;
  const [rawTimestamp, id, cursorBinding, extra] = value.split("|");
  const timestamp = new Date(rawTimestamp ?? "");
  if (extra !== undefined || !id || !POSITIVE_BIGINT_PATTERN.test(id) ||
      Number.isNaN(timestamp.getTime())) {
    invalidCursor(code, message);
  }
  requireBinding(cursorBinding, binding, code, message);
  return { id, timestamp };
}

export function encodeDateBigintCursor(timestamp: Date, id: string, binding?: string): string {
  return `${timestamp.toISOString()}|${id}${binding === undefined ? "" : `|${binding}`}`;
}

export function decodeBigintUuidCursor(
  value: string | undefined,
  code: string,
  message: string,
  binding?: string,
): { id: string; sequence: string } | null {
  if (value === undefined) return null;
  const [sequence, id, cursorBinding, extra] = value.split("|");
  if (extra !== undefined || !sequence || !POSITIVE_BIGINT_PATTERN.test(sequence) ||
      !id || !UUID_PATTERN.test(id)) {
    invalidCursor(code, message);
  }
  requireBinding(cursorBinding, binding, code, message);
  return { id, sequence };
}

export function encodeBigintUuidCursor(sequence: string, id: string, binding?: string): string {
  return `${sequence}|${id}${binding === undefined ? "" : `|${binding}`}`;
}
