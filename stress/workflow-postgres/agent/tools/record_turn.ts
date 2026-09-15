/**
 * Stress-fixture side-effect tool.
 *
 * Export:
 * - Records each turn ordinal exactly once in PostgreSQL; replayed execution fails on the primary key.
 */
import pg from "pg";
import { defineTool } from "eve/tools";
import { z } from "zod";

const { Client } = pg;

export default defineTool({
  description: "Record one deterministic stress turn side effect.",
  inputSchema: z.object({ ordinal: z.number().int().positive() }),
  async execute({ ordinal }) {
    const connectionString = process.env.WORKFLOW_POSTGRES_URL;
    if (!connectionString) {
      throw new Error(
        "AGENT_WORKFLOW_STRESS_DATABASE_CONFIG_MISSING: Не задано подключение к тестовой базе Workflow",
      );
    }

    // A fresh client makes each observed insert an independent external side-effect boundary.
    const client = new Client({ connectionString });
    await client.connect();
    try {
      await client.query(
        "INSERT INTO workflow_stress_side_effects (ordinal) VALUES ($1)",
        [ordinal],
      );
    } finally {
      await client.end();
    }
    return { ordinal, recorded: true };
  },
});
