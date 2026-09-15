/**
 * Workflow PostgreSQL bootstrap tests.
 *
 * Tests:
 * - Required isolated connection validation without implicit package fallbacks.
 * - Safe PostgreSQL password literal construction.
 * - Dedicated role/database creation and ownership conflict rejection.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  provisionWorkflowDatabase,
  quotePostgresLiteral,
  requireWorkflowDatabaseConfig,
} from "./migrate-workflow.js";

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalWorkflowUrl = process.env.WORKFLOW_POSTGRES_URL;

afterEach(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalWorkflowUrl === undefined) delete process.env.WORKFLOW_POSTGRES_URL;
  else process.env.WORKFLOW_POSTGRES_URL = originalWorkflowUrl;
});

describe("Workflow database configuration", () => {
  it("fails closed when the dedicated connection is absent", () => {
    process.env.DATABASE_URL = "postgresql://osinara:secret@postgres:5432/osinara";
    delete process.env.WORKFLOW_POSTGRES_URL;

    expect(() => requireWorkflowDatabaseConfig()).toThrowError(
      /AGENT_WORKFLOW_DATABASE_CONFIG_MISSING/u,
    );
  });

  it("accepts only the fixed role and database on the application PostgreSQL host", () => {
    process.env.DATABASE_URL = "postgresql://osinara:secret@postgres:5432/osinara";
    process.env.WORKFLOW_POSTGRES_URL =
      "postgresql://osinara_workflow:workflow%27secret@postgres:5432/osinara_workflow";

    expect(requireWorkflowDatabaseConfig()).toEqual({
      adminUrl: process.env.DATABASE_URL,
      workflowPassword: "workflow'secret",
      workflowUrl: process.env.WORKFLOW_POSTGRES_URL,
    });
    process.env.WORKFLOW_POSTGRES_URL =
      "postgresql://osinara:secret@postgres:5432/osinara";
    expect(() => requireWorkflowDatabaseConfig()).toThrowError(
      /AGENT_WORKFLOW_DATABASE_BOUNDARY_INVALID/u,
    );
  });

  it("quotes role passwords without allowing literal termination", () => {
    expect(quotePostgresLiteral("workflow'secret")).toBe("'workflow''secret'");
    expect(() => quotePostgresLiteral("bad\0secret")).toThrowError(
      /AGENT_WORKFLOW_DATABASE_PASSWORD_INVALID/u,
    );
  });
});

describe("provisionWorkflowDatabase", () => {
  it("creates a least-privilege role and its dedicated database", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ exists: false }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const client = {
      connect: vi.fn().mockResolvedValue(undefined),
      end: vi.fn().mockResolvedValue(undefined),
      query,
    };

    await provisionWorkflowDatabase({
      adminUrl: "postgresql://osinara:secret@postgres:5432/osinara",
      workflowPassword: "workflow-secret",
      workflowUrl: "postgresql://osinara_workflow:workflow-secret@postgres:5432/osinara_workflow",
    }, () => client);

    expect(query.mock.calls[1]?.[0]).toContain(
      "CREATE ROLE osinara_workflow LOGIN PASSWORD 'workflow-secret' NOSUPERUSER",
    );
    expect(query.mock.calls[3]?.[0]).toBe(
      "CREATE DATABASE osinara_workflow OWNER osinara_workflow",
    );
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("rejects an existing Workflow database owned by another role", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ owner: "osinara" }] });
    const client = {
      connect: vi.fn().mockResolvedValue(undefined),
      end: vi.fn().mockResolvedValue(undefined),
      query,
    };

    await expect(provisionWorkflowDatabase({
      adminUrl: "postgresql://osinara:secret@postgres:5432/osinara",
      workflowPassword: "workflow-secret",
      workflowUrl: "postgresql://osinara_workflow:workflow-secret@postgres:5432/osinara_workflow",
    }, () => client)).rejects.toThrowError(/AGENT_WORKFLOW_DATABASE_OWNER_INVALID/u);
    expect(client.end).toHaveBeenCalledOnce();
  });
});
