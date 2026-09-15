/**
 * External-group effective capability instruction tests.
 *
 * Constructs covered:
 * - `externalGroupCapabilityInstructions`: renders exact model-visible effective capabilities.
 * - Action-level memory grants remain granular and do not imply sibling actions.
 * - Application-core descriptors are included in the same exact effective surface.
 * - Image skill loading is advertised only with its live capability.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../image-generation/image-generation-availability.js", () => ({
  IMAGE_GENERATION_AVAILABLE: true,
}));

import { externalGroupCapabilityInstructions } from "./external-group-capability-instructions.js";

describe("externalGroupCapabilityInstructions", () => {
  it("includes always-available files and only explicitly allowed application capabilities", () => {
    const markdown = externalGroupCapabilityInstructions(
      new Set(["remember", "manage_memory.undo"]),
    );

    expect(markdown).toContain("`glob`");
    expect(markdown).toContain("`grep`");
    expect(markdown).toContain("`read_file`");
    expect(markdown).toContain("`write_file`");
    expect(markdown).toContain("`remember`");
    expect(markdown).toContain("`manage_memory` с `action=undo`");
    expect(markdown).toContain(
      "Effective allowlist: `glob`, `grep`, `read_file`, `write_file`, `manage_memory` с `action=undo`, `remember`.",
    );
    expect(markdown).not.toContain("`manage_memory` с `action=edit`");
    expect(markdown).not.toContain("`manage_memory` с `action=delete`");
    expect(markdown).not.toContain("`search_memories`");
  });

  it("uses the executable manage_memory_thread name for action-level grants", () => {
    const markdown = externalGroupCapabilityInstructions(
      new Set(["manage_memory_thread.complete", "manage_memory_thread.reactivate"]),
    );

    expect(markdown).toContain("`manage_memory_thread` с `action=complete`");
    expect(markdown).toContain("`manage_memory_thread` с `action=reactivate`");
    expect(markdown).not.toContain("`manage_memory_thread.complete`");
  });

  it("includes independently issued application-core and scheduled-history tools", () => {
    const markdown = externalGroupCapabilityInstructions(new Set(), {
      includeApplicationCore: true,
      scheduledHistory: true,
      scheduledRun: false,
    });

    expect(markdown).toContain("`read_profile_view`");
    expect(markdown).toContain("`manage_behavior_preference`");
    expect(markdown).toContain("`read_scheduled_group_history`");
    expect(markdown).not.toMatch(/не вызывай.*другие видимые static descriptors/isu);
  });

  it("does not advertise interactive preferences during a scheduled run", () => {
    const markdown = externalGroupCapabilityInstructions(new Set(), {
      includeApplicationCore: true,
      scheduledHistory: true,
      scheduledRun: true,
    });

    expect(markdown).toContain("`read_profile_view`");
    expect(markdown).toContain("`read_scheduled_group_history`");
    expect(markdown).not.toContain("`manage_behavior_preference`");
  });

  it("forbids offering any other visible static descriptor", () => {
    const markdown = externalGroupCapabilityInstructions(new Set());

    expect(markdown).toMatch(
      /не вызывай, не предлагай и не утверждай, что можешь использовать инструменты, не перечисленные выше/iu,
    );
  });

  it("does not advertise removed custom skills", () => {
    const markdown = externalGroupCapabilityInstructions(new Set());

    expect(markdown).not.toContain("`load_skill`");
    expect(markdown).not.toContain("`pohuy`");
  });

  it("advertises imagegen instructions only with generate_image", () => {
    const denied = externalGroupCapabilityInstructions(new Set());
    const granted = externalGroupCapabilityInstructions(new Set(["generate_image"]));
    const scheduled = externalGroupCapabilityInstructions(new Set(["generate_image"]), {
      includeApplicationCore: true,
      scheduledHistory: true,
      scheduledRun: true,
    });

    expect(denied).not.toContain("skill=imagegen");
    expect(granted).toContain("`load_skill` с `skill=imagegen`");
    expect(granted).toContain("Effective skills: `imagegen`.");
    expect(scheduled).not.toContain("skill=imagegen");
    expect(scheduled).not.toContain("`generate_image`");
  });

  it("advertises the analyst skills only with web_search and never in a scheduled run", () => {
    const denied = externalGroupCapabilityInstructions(new Set(["web_fetch"]));
    const granted = externalGroupCapabilityInstructions(new Set(["web_search", "web_fetch"]));
    const scheduled = externalGroupCapabilityInstructions(new Set(["web_search"]), {
      includeApplicationCore: false,
      scheduledHistory: false,
      scheduledRun: true,
    });

    expect(denied).not.toContain("auto-analyst");
    expect(granted).toContain("`load_skill` с `skill=auto-analyst`");
    expect(granted).toContain("`load_skill` с `skill=policy-finance-analyst`");
    expect(scheduled).not.toContain("auto-analyst");
  });

  it("advertises granted authored skills with their descriptions, never in a scheduled run", () => {
    const authoredSkills = [{ description: "Сводка недели по чату", name: "weekly-digest" }];
    const granted = externalGroupCapabilityInstructions(new Set(["web_search"]), {
      authoredSkills, includeApplicationCore: true, scheduledHistory: false, scheduledRun: false,
    });
    const scheduled = externalGroupCapabilityInstructions(new Set(["web_search"]), {
      authoredSkills, includeApplicationCore: false, scheduledHistory: false, scheduledRun: true,
    });

    expect(granted).toContain("`load_skill` с `skill=weekly-digest`: Сводка недели по чату.");
    expect(granted).toContain("`auto-analyst`, `policy-finance-analyst`, `weekly-digest`");
    expect(scheduled).not.toContain("weekly-digest");
  });

  it("marks static trusted-only Google Workspace skills as unavailable externally", () => {
    const markdown = externalGroupCapabilityInstructions(new Set());

    expect(markdown).toMatch(/Google Workspace.*не доступны.*внешн/iu);
    expect(markdown).not.toMatch(/`gws-[^`]+`/u);
  });
});
