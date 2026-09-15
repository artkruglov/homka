/** An idle PostgreSQL client may fail at any time; the pool must report it without crashing the process. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { closeDatabase, database } from "./database.js";

describe("application database pool", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await closeDatabase();
  });

  it("logs an idle client connection error with a stable code and no connection secrets", () => {
    vi.stubEnv("DATABASE_URL", "postgresql://agent:super-secret-password@db.internal:5432/agent");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pool = database();
    const failure = Object.assign(
      new Error("terminating connection due to administrator command for agent:super-secret-password"),
      { code: "57P01" },
    );

    // pg-pool re-emits an idle client's socket error on the pool; without a listener Node throws it.
    expect(() => pool.emit("error", failure, {})).not.toThrow();

    expect(log).toHaveBeenCalledOnce();
    const line = String(log.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toEqual({
      code: "AGENT_DATABASE_POOL_ERROR",
      databaseCode: "57P01",
      errorName: "Error",
    });
    expect(line).not.toContain("super-secret-password");
    expect(line).not.toContain("db.internal");
  });
});
