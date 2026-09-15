/**
 * Database bookkeeping recovery tests.
 *
 * Constructs covered:
 * - `isTransientDatabaseConnectionError`: connection loss only, never a query or application error.
 * - `recoverDatabaseBookkeeping`: bounded retries with backoff for a lost connection, no retry otherwise.
 */
import { describe, expect, it, vi } from "vitest";

import { AppError } from "./app-error.js";
import { isTransientDatabaseConnectionError, recoverDatabaseBookkeeping } from "./database-recovery.js";

const withCode = (message: string, code: string) => Object.assign(new Error(message), { code });

describe("isTransientDatabaseConnectionError", () => {
  it("recognizes a lost or refused PostgreSQL connection", () => {
    expect(isTransientDatabaseConnectionError(withCode("terminating connection due to administrator command", "57P01"))).toBe(true);
    expect(isTransientDatabaseConnectionError(withCode("connection failure", "08006"))).toBe(true);
    expect(isTransientDatabaseConnectionError(withCode("too many clients already", "53300"))).toBe(true);
    expect(isTransientDatabaseConnectionError(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(isTransientDatabaseConnectionError(withCode("connect ECONNREFUSED 10.0.0.2:5432", "ECONNREFUSED"))).toBe(true);
    expect(isTransientDatabaseConnectionError(Object.assign(new Error("wrapped"), {
      cause: withCode("read ECONNRESET", "ECONNRESET"),
    }))).toBe(true);
  });

  it("does not treat a query, constraint or application error as transient", () => {
    expect(isTransientDatabaseConnectionError(withCode("duplicate key value", "23505"))).toBe(false);
    expect(isTransientDatabaseConnectionError(withCode("could not serialize access", "40001"))).toBe(false);
    expect(isTransientDatabaseConnectionError(new AppError("AGENT_REMINDER_LEASE_STALE", "Доставка напоминания уже неактуальна"))).toBe(false);
    expect(isTransientDatabaseConnectionError(new Error("boom"))).toBe(false);
    expect(isTransientDatabaseConnectionError("Connection terminated unexpectedly")).toBe(false);
  });
});

describe("recoverDatabaseBookkeeping", () => {
  it("retries a lost connection with backoff until the write succeeds", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error("Connection terminated unexpectedly"))
      .mockRejectedValueOnce(withCode("terminating connection", "57P01"))
      .mockResolvedValueOnce("recorded");

    await expect(recoverDatabaseBookkeeping(operation, { sleep })).resolves.toBe("recorded");
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000, 3_000]);
  });

  it("gives up after the bounded attempts with the last connection error", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const last = withCode("connection failure", "08006");
    const operation = vi.fn().mockRejectedValue(last);

    await expect(recoverDatabaseBookkeeping(operation, { sleep })).rejects.toBe(last);
    expect(operation).toHaveBeenCalledTimes(4);
  });

  it("does not retry a non-connection error", async () => {
    const sleep = vi.fn();
    const stale = new AppError("AGENT_REMINDER_LEASE_STALE", "Доставка напоминания уже неактуальна");
    const operation = vi.fn().mockRejectedValue(stale);

    await expect(recoverDatabaseBookkeeping(operation, { sleep })).rejects.toBe(stale);
    expect(operation).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });
});
