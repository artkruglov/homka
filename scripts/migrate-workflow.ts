/**
 * PostgreSQL Workflow database bootstrap boundary.
 *
 * Exports:
 * - `requireWorkflowDatabaseConfig`: validates the isolated fixed database and role contract.
 * - `quotePostgresLiteral`: safely quotes the generated role password for PostgreSQL DDL.
 * - `provisionWorkflowDatabase`: creates or verifies the dedicated role and database.
 * - `runWorkflowMigration`: provisions storage and invokes the official schema bootstrap.
 *
 * Runtime:
 * - Provisions the database with the application administrator connection.
 * - Runs the official `@workflow/world-postgres` bootstrap CLI as an isolated child process.
 */
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import pg from "pg";

const { Client } = pg;
const WORKFLOW_DATABASE = "osinara_workflow";
const WORKFLOW_ROLE = "osinara_workflow";

interface WorkflowDatabaseConfig {
  adminUrl: string;
  workflowPassword: string;
  workflowUrl: string;
}

interface QueryClient {
  connect(): Promise<unknown>;
  end(): Promise<void>;
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
}

type CreateClient = (connectionString: string) => QueryClient;

function requiredEnvironment(name: "DATABASE_URL" | "WORKFLOW_POSTGRES_URL"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `AGENT_WORKFLOW_DATABASE_CONFIG_MISSING: Не задан обязательный параметр ${name}`,
    );
  }
  return value;
}

export function requireWorkflowDatabaseConfig(): WorkflowDatabaseConfig {
  const adminUrl = requiredEnvironment("DATABASE_URL");
  const workflowUrl = requiredEnvironment("WORKFLOW_POSTGRES_URL");
  let admin: URL;
  let workflow: URL;
  try {
    admin = new URL(adminUrl);
    workflow = new URL(workflowUrl);
  } catch (error) {
    throw new Error(
      "AGENT_WORKFLOW_DATABASE_URL_INVALID: Строка подключения Workflow к PostgreSQL некорректна",
      { cause: error },
    );
  }

  // Fixed identities make every DDL identifier static and keep Workflow out of application tables.
  if (
    !["postgres:", "postgresql:"].includes(workflow.protocol) ||
    workflow.username !== WORKFLOW_ROLE ||
    workflow.pathname !== `/${WORKFLOW_DATABASE}` ||
    workflow.hostname !== admin.hostname ||
    workflow.port !== admin.port ||
    !workflow.password
  ) {
    throw new Error(
      "AGENT_WORKFLOW_DATABASE_BOUNDARY_INVALID: Workflow должен использовать отдельные базу и роль osinara_workflow на основном PostgreSQL",
    );
  }
  return {
    adminUrl,
    workflowPassword: decodeURIComponent(workflow.password),
    workflowUrl,
  };
}

export function quotePostgresLiteral(value: string): string {
  if (!value || value.includes("\0")) {
    throw new Error(
      "AGENT_WORKFLOW_DATABASE_PASSWORD_INVALID: Пароль роли Workflow пуст или содержит недопустимый символ",
    );
  }
  return `'${value.replaceAll("'", "''")}'`;
}

export async function provisionWorkflowDatabase(
  config: WorkflowDatabaseConfig,
  createClient: CreateClient = (connectionString) => new Client({ connectionString }),
): Promise<void> {
  const admin = createClient(config.adminUrl);
  await admin.connect();
  try {
    // Reconcile the generated secret on every migration while preserving least-privilege role flags.
    const role = await admin.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists",
      [WORKFLOW_ROLE],
    );
    const password = quotePostgresLiteral(config.workflowPassword);
    if (role.rows[0]?.exists === true) {
      await admin.query(
        `ALTER ROLE ${WORKFLOW_ROLE} LOGIN PASSWORD ${password} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`,
      );
    } else {
      await admin.query(
        `CREATE ROLE ${WORKFLOW_ROLE} LOGIN PASSWORD ${password} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`,
      );
    }

    // CREATE DATABASE cannot run in a transaction; a fixed owner makes subsequent migrations isolated.
    const database = await admin.query<{ owner: string }>(
      `SELECT owner.rolname AS owner
         FROM pg_database database
         JOIN pg_roles owner ON owner.oid = database.datdba
        WHERE database.datname = $1`,
      [WORKFLOW_DATABASE],
    );
    if (database.rows.length === 0) {
      await admin.query(`CREATE DATABASE ${WORKFLOW_DATABASE} OWNER ${WORKFLOW_ROLE}`);
    } else if (database.rows[0]?.owner !== WORKFLOW_ROLE) {
      throw new Error(
        "AGENT_WORKFLOW_DATABASE_OWNER_INVALID: База Workflow существует, но принадлежит другой роли",
      );
    }
  } finally {
    await admin.end();
  }
}

async function runOfficialBootstrap(): Promise<void> {
  const cliPath = fileURLToPath(import.meta.resolve("@workflow/world-postgres/cli"));
  const child = spawn(process.execPath, [cliPath], {
    env: process.env,
    stdio: "inherit",
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (exitCode !== 0) {
    throw new Error(
      `AGENT_WORKFLOW_DATABASE_MIGRATION_FAILED: Миграция Workflow завершилась с кодом ${String(exitCode)}`,
    );
  }
}

export async function runWorkflowMigration(): Promise<void> {
  const config = requireWorkflowDatabaseConfig();
  await provisionWorkflowDatabase(config);
  await runOfficialBootstrap();
}

// Keep imports side-effect free for focused unit tests; the bundled runtime remains directly executable.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runWorkflowMigration();
}
