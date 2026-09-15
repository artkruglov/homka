/**
 * Agent capability surface regression tests.
 *
 * Constructs:
 * - `agent/tools` holds only the dynamic resolver; native `agent` supplies fresh-context delegation.
 * - Exact application tool-module allowlist after CRUD consolidation.
 * - Exact static package directories plus lifecycle-scoped dynamic resolvers.
 * - The compiled dynamic resolver stays step-scoped and avoids durable helper-closure replay.
 */
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const AGENT_ROOT = fileURLToPath(new URL("..", import.meta.url));

const EXPECTED_TOOL_MODULES = [
  "execute_google_workspace.ts",
  "export_memory.ts",
  "generate_image.ts",
  "generate_video.ts",
  "get_current_time.ts",
  "get_memory_source.ts",
  "grocery_cart.ts",
  "import_telegram_attachment.ts",
  "inspect_workspace_image.ts",
  "list_agent_schedules.ts",
  "list_group_history.ts",
  "list_memories.ts",
  "list_memory_threads.ts",
  "list_pending_family_invitations.ts",
  "list_proactive_deliveries.ts",
  "list_reminders.ts",
  "list_telegram_attachments.ts",
  "manage_agent_schedule.ts",
  "manage_behavior_preference.ts",
  "manage_care_areas.ts",
  "manage_errand.ts",
  "manage_external_group_schedule.ts",
  "manage_family_invitation.ts",
  "manage_gmail_message.ts",
  "manage_google_workspace_connection.ts",
  "manage_joint_decision.ts",
  "manage_memory.ts",
  "manage_memory_conflict.ts",
  "manage_memory_thread.ts",
  "manage_personal_time.ts",
  "manage_profile_projection.ts",
  "manage_reminder.ts",
  "manage_shared_tasks.ts",
  "manage_shopping_list.ts",
  "manage_skill.ts",
  "manage_space.ts",
  "manage_telegram_group.ts",
  "notification_settings.ts",
  "publish_memory.ts",
  "read_memory_thread.ts",
  "read_profile_view.ts",
  "read_scheduled_group_history.ts",
  "read_shared_tasks.ts",
  "remember.ts",
  "review_improvements.ts",
  "search_memories.ts",
  "search_memory_threads.ts",
  "search_my_contexts.ts",
  "send_to_chat.ts",
  "send_workspace_file.ts",
  "start_new_context.ts",
] as const;

const EXPECTED_DISCOVERED_TOOL_FILES = ["capabilities.ts"] as const;

// A family assistant ships no developer-docs lookup and no brokerage skill by default; the
// brokerage package is restorable from git history when a household actually uses T-Invest.
const EXPECTED_SKILL_DIRECTORIES = [
  "agent-browser",
  "auto-analyst",
  "behavior-preferences",
  "policy-finance-analyst",
  "skill-authoring",
] as const;

describe("agent capability surface", () => {
  it("discovers only the dynamic resolver so Eve provides native delegation", async () => {
    const entries = await readdir(`${AGENT_ROOT}/tools`, { withFileTypes: true });
    const toolFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => entry.name)
      .sort();

    expect(toolFiles).toEqual([...EXPECTED_DISCOVERED_TOOL_FILES]);
  });

  it("keeps every application tool implementation outside Eve discovery", async () => {
    const entries = await readdir(`${AGENT_ROOT}/lib/tools`, { withFileTypes: true });
    const toolModules = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => entry.name)
      .sort();

    expect(toolModules).toEqual([...EXPECTED_TOOL_MODULES]);
  });

  it("keeps static packages separate from the dynamic policy resolver", async () => {
    const entries = await readdir(`${AGENT_ROOT}/skills`, { withFileTypes: true });
    const skillDirectories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(skillDirectories).toEqual([...EXPECTED_SKILL_DIRECTORIES]);
    const skillFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => entry.name)
      .sort();
    expect(skillFiles).toEqual(["authored.ts", "external.ts", "scoped.ts"]);
  });

  it("requires every native skill package to declare SKILL.md", async () => {
    await Promise.all(
      EXPECTED_SKILL_DIRECTORIES.map(async (skillName) => {
        const files = await readdir(`${AGENT_ROOT}/skills/${skillName}`);

        expect(files).toContain("SKILL.md");
      }),
    );
  });

  it("authors the whole dynamic tool surface at step scope", async () => {
    const source = await readFile(`${AGENT_ROOT}/tools/capabilities.ts`, "utf8");

    // Timing wrappers can return the async result without an `async` event callback. The
    // lifecycle key is the contract: tools must still be resolved before every model step.
    expect(source).toContain('"step.started":');
    expect(source).not.toContain('"turn.started"');
  });
});
