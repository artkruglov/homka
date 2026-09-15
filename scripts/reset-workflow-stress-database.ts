/**
 * Destructive reset for the isolated Docker Workflow stress database.
 *
 * Runtime:
 * - Requires an explicit test-only guard and exact fixed database identity.
 * - Terminates stale stress connections, then drops the disposable database and role.
 * - Production and development commands never invoke this script.
 */
import pg from "pg";

const { Client } = pg;
const WORKFLOW_DATABASE = "osinara_workflow";
const WORKFLOW_ROLE = "osinara_workflow";

if (process.env.WORKFLOW_STRESS_RESET_ALLOWED !== "true") {
  throw new Error(
    "AGENT_WORKFLOW_STRESS_RESET_FORBIDDEN: Сброс тестовой базы требует явного разрешения",
  );
}
const adminUrl = process.env.DATABASE_URL;
const workflowUrl = process.env.WORKFLOW_POSTGRES_URL;
if (!adminUrl || !workflowUrl) {
  throw new Error(
    "AGENT_WORKFLOW_STRESS_DATABASE_CONFIG_MISSING: Не заданы подключения к тестовым базам",
  );
}
const admin = new URL(adminUrl);
const workflow = new URL(workflowUrl);
// The Docker test service reaches PostgreSQL as `postgres`; a developer runs the same disposable
// databases on the loopback container from the host. Both stay bound to the fixed test names.
const TEST_DATABASE_HOSTS = new Set(["postgres", "localhost", "127.0.0.1"]);
if (
  !TEST_DATABASE_HOSTS.has(admin.hostname) ||
  admin.pathname !== "/osinara_test" ||
  !TEST_DATABASE_HOSTS.has(workflow.hostname) ||
  workflow.pathname !== `/${WORKFLOW_DATABASE}` ||
  workflow.username !== WORKFLOW_ROLE
) {
  throw new Error(
    "AGENT_WORKFLOW_STRESS_RESET_BOUNDARY_INVALID: Сброс разрешён только для Docker-баз osinara_test/osinara_workflow",
  );
}

const client = new Client({ connectionString: adminUrl });
await client.connect();
try {
  // No stress server is expected now; terminate abandoned eval connections before dropping the DB.
  await client.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
    [WORKFLOW_DATABASE],
  );
  await client.query(`DROP DATABASE IF EXISTS ${WORKFLOW_DATABASE}`);
  await client.query(`DROP ROLE IF EXISTS ${WORKFLOW_ROLE}`);
} finally {
  await client.end();
}
