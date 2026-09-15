/**
 * Eve terminal session retention job tests.
 *
 * Constructs covered:
 * - A dedicated PostgreSQL advisory lock serializes physical Workflow graph deletion.
 * - A concurrent invocation exits without claiming a second application session.
 * - Destroying the lock connection releases the session-level lock after the sweep.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const values = vi.hoisted(() => {
  let lockHeld = false;
  let resolveDeletion!: () => void;
  const deletionPromise = new Promise<void>((resolve) => {
    resolveDeletion = resolve;
  });
  const lockRelease = vi.fn((destroy?: boolean) => {
    if (destroy) lockHeld = false;
  });
  const lockQuery = vi.fn(async () => {
    if (lockHeld) return { rows: [{ acquired: false }] };
    lockHeld = true;
    return { rows: [{ acquired: true }] };
  });
  return {
    claimExpiredForDeletion: vi.fn(),
    completeDeletion: vi.fn(),
    connect: vi.fn(async () => ({ query: lockQuery, release: lockRelease })),
    deletePostgresEveSession: vi.fn(async () => deletionPromise),
    failDeletion: vi.fn(),
    lockQuery,
    lockRelease,
    resolveDeletion,
    retireAbandonedTasks: vi.fn(),
  };
});

vi.mock("../database.js", () => ({
  database: () => ({ connect: values.connect }),
}));
vi.mock("./workflow-postgres-session-storage.js", () => ({
  deleteConfiguredPostgresEveSession: values.deletePostgresEveSession,
}));
vi.mock("./session-repository.js", () => ({
  sessionRepository: {
    claimExpiredForDeletion: values.claimExpiredForDeletion,
    completeDeletion: values.completeDeletion,
    failDeletion: values.failDeletion,
    retireAbandonedTasks: values.retireAbandonedTasks,
  },
}));

import { deleteExpiredSessions } from "./session-retention.js";

describe("deleteExpiredSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    values.claimExpiredForDeletion
      .mockResolvedValueOnce({
        eveSessionId: "wrun_01KXB392VJ8YY13JMJ9YZAF5QR",
        id: "application-session-1",
        leaseToken: "lease-1",
      })
      .mockResolvedValue(null);
  });

  it("serializes physical deletion across concurrent retention jobs", async () => {
    const first = deleteExpiredSessions();
    await vi.waitFor(() => expect(values.deletePostgresEveSession).toHaveBeenCalledTimes(1));

    await expect(deleteExpiredSessions()).resolves.toBe(0);
    expect(values.claimExpiredForDeletion).toHaveBeenCalledTimes(1);
    expect(values.lockRelease).toHaveBeenCalledWith(false);

    values.resolveDeletion();
    await expect(first).resolves.toBe(1);
    expect(values.completeDeletion).toHaveBeenCalledWith(
      "application-session-1",
      "lease-1",
    );
    expect(values.lockRelease).toHaveBeenLastCalledWith(true);
  });
});
