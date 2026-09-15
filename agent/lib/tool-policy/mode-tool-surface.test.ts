/**
 * Mode-scoped tool surface tests.
 *
 * Constructs covered:
 * - Each trust zone emits exactly its own application tools and nothing from another zone.
 * - An external group emits guarded file tools, granted capabilities, and framework denials.
 * - Granted capabilities re-check the live policy at execution and stay action-level for memory.
 * - HITL approval configuration survives dynamic emission.
 * - Native subagents stay unavailable externally and cannot make root-owned durable-memory decisions.
 */
import type { SessionAuth } from "eve/context";
import { webFetch as eveWebFetch } from "eve/tools/defaults";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const loadCurrentExternalGroupCapabilities = vi.hoisted(() => vi.fn());
const authorizeCurrentExternalGroupCapability = vi.hoisted(() => vi.fn());

// The trusted matrix under test includes the Google tools, which exist only with OAuth credentials.
vi.mock("../google-workspace/google-workspace-availability.js", () => ({
  GOOGLE_WORKSPACE_AVAILABLE: true,
}));
vi.mock("../video-generation/video-generation-availability.js",()=>({VIDEO_GENERATION_AVAILABLE:true}));
// Каталог продуктов настраивается переменной окружения, но матрица режимов обязана называть его
// место независимо от настройки: иначе классификация проверялась бы только там, где он включён.
vi.mock("../grocery/grocery-config.js", () => ({
  GROCERY_AVAILABLE: true,
  GROCERY_CART_MAX_ITEMS: 20,
  GROCERY_CART_MAX_QUANTITY: 40,
  GROCERY_CART_MIN_QUANTITY: 0.01,
  GROCERY_MCP_URL: "https://example.test/mcp",
  GROCERY_REQUEST_TIMEOUT_MS: 15_000,
  GROCERY_SEARCH_MAX_ITEMS: 10,
}));
vi.mock("./external-group-live-policy.js", () => ({
  loadCurrentExternalGroupCapabilities,
  authorizeCurrentExternalGroupCapability,
}));

import { FAMILY_ONLY_TOOL_NAMES, PRIVATE_ONLY_TOOL_NAMES, TRUSTED_MODE_TOOL_NAMES, buildModeToolSurface, buildSubagentToolSurface } from "./mode-tool-surface.js";
import { TRUSTED_MODE_TOOLS } from "./trusted-mode-tool-catalog.js";
import { ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES, EXTERNAL_GROUP_TOOL_NAMES, FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS, type ExternalGroupToolName } from "./group-tool-catalog.js";

function names(input: Parameters<typeof buildModeToolSurface>[0]): string[] {
  return Object.keys(buildModeToolSurface(input)).sort();
}

function externalAuth(toolAllowlist: readonly string[]): SessionAuth {
  return {
    current: {
      attributes: {
        familyId: "family-1",
        groupId: "group-1",
        groupType: "external",
        role: "external",
        toolAllowlist,
      },
      authenticator: "telegram",
      principalId: "telegram:101",
      principalType: "user",
    },
    initiator: null,
  };
}

describe("trusted mode tool surfaces", () => {
  it('exposes video and durable waiting only to interactive trusted roots',()=>{
    for(const environment of ['private','family'] as const){
      expect(buildModeToolSurface({environment})).toHaveProperty('generate_video');
      expect(buildModeToolSurface({environment})).toHaveProperty('sleep');
      for(const surface of [buildModeToolSurface({environment,scheduledRun:true}),buildSubagentToolSurface({environment})]){
        expect(surface).not.toHaveProperty('generate_video');expect(surface).not.toHaveProperty('sleep');
      }
    }
    expect(buildModeToolSurface({environment:'external',capabilities:new Set()})).not.toHaveProperty('generate_video');
    const granted=buildModeToolSurface({environment:'external',capabilities:new Set(['generate_video'])});
    expect(granted).toHaveProperty('generate_video');expect(granted).toHaveProperty('sleep');
    const scheduled=buildModeToolSurface({environment:'external',capabilities:new Set(['generate_video']),scheduledRun:true});
    expect(scheduled).not.toHaveProperty('generate_video');expect(scheduled).not.toHaveProperty('sleep');
  });
  it("gives a private chat the shared tools plus owner administration only", () => {
    expect(names({ environment: "private" })).toEqual([...TRUSTED_MODE_TOOL_NAMES, ...PRIVATE_ONLY_TOOL_NAMES].sort());
    expect(names({ environment: "private" })).toContain("manage_external_group_schedule");
  });

  it("exposes R3 profile policy and provenance only in the intended trust zones", () => {
    const privateNames = names({ environment: "private" });
    const familyNames = names({ environment: "family" });
    const externalNames = names({
      capabilities: new Set(),
      environment: "external",
    });

    expect(privateNames).toEqual(
      expect.arrayContaining(["get_memory_source", "list_memory_threads", "manage_memory_thread", "manage_profile_projection", "read_memory_thread", "read_profile_view", "search_memory_threads"]),
    );
    expect(familyNames).toEqual(expect.arrayContaining(["list_memory_threads", "manage_memory_thread", "read_memory_thread", "read_profile_view", "search_memory_threads"]));
    expect(familyNames).not.toContain("get_memory_source");
    expect(externalNames).toEqual(expect.arrayContaining(["read_profile_view"]));
  });

  it("gives a family group the shared tools plus group history and attachments only", () => {
    expect(names({ environment: "family" })).toEqual([...TRUSTED_MODE_TOOL_NAMES, ...FAMILY_ONLY_TOOL_NAMES].sort());
    expect(names({ environment: "family" })).not.toContain("manage_external_group_schedule");
  });

  it("exposes the run-bound history reader only to a scheduled external turn", () => {
    const ordinary = names({
      capabilities: new Set(),
      environment: "external",
    });
    const scheduled = names({
      capabilities: new Set(),
      environment: "external",
      scheduledHistory: true,
    } as never);

    expect(ordinary).not.toContain("read_scheduled_group_history");
    expect(scheduled).toContain("read_scheduled_group_history");
    expect(scheduled).toContain("agent");
  });

  it("never exposes another zone's tools", () => {
    const privateNames = names({ environment: "private" });
    const familyNames = names({ environment: "family" });

    for (const familyOnly of FAMILY_ONLY_TOOL_NAMES) {
      expect(privateNames, `private must not expose ${familyOnly}`).not.toContain(familyOnly);
    }
    for (const privateOnly of PRIVATE_ONLY_TOOL_NAMES) {
      expect(familyNames, `family must not expose ${privateOnly}`).not.toContain(privateOnly);
    }
  });

  it("emits no denial stubs in a trusted zone", () => {
    for (const environment of ["private", "family"] as const) {
      for (const denied of FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS) {
        // web_fetch is the one built-in a trusted zone re-describes; it keeps Eve's executor below.
        if (denied === "web_fetch") continue;
        expect(names({ environment }), `${environment} must not override ${denied}`).not.toContain(denied);
      }
    }
  });

  it("re-describes web_fetch in a trusted zone without replacing Eve's executor", () => {
    for (const environment of ["private", "family"] as const) {
      const surface = buildModeToolSurface({ environment });
      const tool = surface.web_fetch as unknown as { description: string; execute: unknown };
      expect(tool.description).toContain("web_search");
      expect(typeof tool.execute).toBe("function");
    }
    // The catalog entry spreads Eve's definition, so the executor is Eve's own before wrapping.
    {
      const catalogTool = TRUSTED_MODE_TOOLS.web_fetch as unknown as { execute: unknown; inputSchema: unknown };
      const eve = eveWebFetch as unknown as { execute: unknown; inputSchema: unknown };
      expect(catalogTool.execute).toBe(eve.execute);
      expect(catalogTool.inputSchema).toBe(eve.inputSchema);
    }
  });

  it("keeps HITL approval configuration after dynamic emission", () => {
    const surface = buildModeToolSurface({ environment: "private" });

    for (const toolName of ["manage_reminder", "manage_agent_schedule", "manage_family_invitation", "manage_gmail_message"]) {
      expect((surface[toolName] as unknown as { approval?: unknown }).approval, `${toolName} must keep its approval policy`).toBeDefined();
    }
  });

  it("keeps the authored-skill library to interactive trusted roots", () => {
    expect(buildModeToolSurface({ environment: "private" })).toHaveProperty("manage_skill");
    expect(buildModeToolSurface({ environment: "family" })).toHaveProperty("manage_skill");
    expect(buildModeToolSurface({ environment: "private", scheduledRun: true })).not.toHaveProperty("manage_skill");
    expect(buildSubagentToolSurface({ environment: "family" })).not.toHaveProperty("manage_skill");
    expect(buildModeToolSurface({ capabilities: new Set(), environment: "external" })).not.toHaveProperty("manage_skill");
    expect(buildModeToolSurface({ environment: "family" }).manage_skill?.approval).toBeTypeOf("function");
  });

  it("names the whole background surface so a new tool cannot slip into it", () => {
    // Фоновый ход и сабагент не имеют собеседника: подтвердить, поправить или остановить их
    // действие некому. Поэтому набор перечислен целиком — новый инструмент обязан быть
    // классифицирован явно, а не попасть туда потому, что о нём забыли.
    const scheduled = Object.keys(buildModeToolSurface({ environment: "private", scheduledRun: true })).sort();
    expect(scheduled).toEqual([
      "execute_google_workspace", "export_memory", "get_current_time", "get_memory_source",
      "inspect_workspace_image", "list_agent_schedules", "list_memories", "list_memory_threads",
      "list_pending_family_invitations", "list_proactive_deliveries", "list_reminders",
      "manage_agent_schedule", "manage_external_group_schedule", "manage_family_invitation",
      "manage_gmail_message", "manage_google_workspace_connection", "manage_memory",
      "manage_memory_conflict", "manage_memory_thread", "manage_profile_projection",
      "manage_reminder", "manage_telegram_group", "notification_settings", "read_memory_thread",
      "read_profile_view", "read_shared_tasks", "review_improvements", "search_memories",
      "search_memory_threads", "send_workspace_file", "start_new_context", "web_fetch",
    ]);
    // Обзор дня собирается из дел, поэтому чтение у фонового хода есть — и только чтение.
    expect(buildSubagentToolSurface({ environment: "family" })).toHaveProperty("read_shared_tasks");
    // В разговоре с человеком второго планировщика нет: там есть настоящий.
    expect(buildModeToolSurface({ environment: "private" })).not.toHaveProperty("read_shared_tasks");
    expect(buildModeToolSurface({ environment: "family" })).not.toHaveProperty("read_shared_tasks");
    for (const surface of [
      buildModeToolSurface({ environment: "private", scheduledRun: true }),
      buildModeToolSurface({ environment: "family", scheduledRun: true }),
      buildSubagentToolSurface({ environment: "private" }),
      buildSubagentToolSurface({ environment: "family" }),
    ]) {
      // Передача в чат и публикация говорят от имени человека, переключатель области меняет
      // рамку следующего хода, корзина создаёт заказ у продавца.
      for (const name of ["send_to_chat", "publish_memory", "manage_space", "manage_shopping_list", "grocery_cart"]) {
        expect(surface).not.toHaveProperty(name);
      }
    }
  });

  it("keeps root-owned durable writes off subagents", () => {
    for(const environment of ["private","family"] as const){
      expect(buildModeToolSurface({environment})).toHaveProperty("manage_joint_decision");
      expect(buildModeToolSurface({environment,scheduledRun:true})).not.toHaveProperty("manage_joint_decision");
      expect(buildSubagentToolSurface({environment})).not.toHaveProperty("manage_joint_decision");
    }
    expect(buildModeToolSurface({ environment: "private" })).toHaveProperty("manage_errand");
    expect(buildModeToolSurface({ environment: "family" })).not.toHaveProperty("manage_errand");
    expect(buildModeToolSurface({ environment: "private", scheduledRun: true })).not.toHaveProperty("manage_errand");
    expect(buildSubagentToolSurface({ environment: "private" })).not.toHaveProperty("manage_errand");
    expect(buildModeToolSurface({ environment: "private" })).toHaveProperty("remember");
    expect(buildSubagentToolSurface({ environment: "private" })).not.toHaveProperty("remember");
    expect(buildModeToolSurface({ environment: "private" })).toHaveProperty("manage_behavior_preference");
    expect(buildSubagentToolSurface({ environment: "private" })).not.toHaveProperty("manage_behavior_preference");
    expect(
      buildSubagentToolSurface({
        capabilities: new Set(["remember"]),
        environment: "external",
      }),
    ).not.toHaveProperty("remember");
    expect(buildModeToolSurface({ environment: "private", scheduledRun: true })).not.toHaveProperty("manage_behavior_preference");
    expect(buildModeToolSurface({ environment: "private", scheduledRun: true })).not.toHaveProperty("remember");
    expect(
      buildModeToolSurface({
        capabilities: new Set(["remember"]),
        environment: "external",
        scheduledRun: true,
      }),
    ).not.toHaveProperty("remember");
  });
});

describe("external group tool surface", () => {
  beforeEach(() => {
    loadCurrentExternalGroupCapabilities.mockReset();
    loadCurrentExternalGroupCapabilities.mockResolvedValue(new Set());
    authorizeCurrentExternalGroupCapability.mockReset();
    authorizeCurrentExternalGroupCapability.mockImplementation(async (identity, capability) => {
      const allowed = await loadCurrentExternalGroupCapabilities(identity);
      if (!allowed.has(capability)) throw new Error("AGENT_GROUP_TOOL_FORBIDDEN");
    });
  });

  it("emits only guarded baseline tools and framework denials without a grant", () => {
    expect(names({ capabilities: new Set(), environment: "external" })).toEqual(
      [...ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES, ...FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS, "load_skill", "manage_behavior_preference", "read_profile_view"].sort(),
    );
  });

  it("denies native child delegation in every interactive external group", async () => {
    const surface = buildModeToolSurface({
      capabilities: new Set(),
      environment: "external",
    });

    expect(surface).toHaveProperty("agent");
    await expect(surface.agent!.execute({ message: "Run a long task" }, {} as never))
      .rejects.toThrowError(/AGENT_GROUP_TOOL_FORBIDDEN/u);
  });

  it("keeps the fail-closed load_skill wrapper without the image capability and denies it in scheduled runs", async () => {
    const interactive = buildModeToolSurface({
      capabilities: new Set(),
      environment: "external",
    }).load_skill!;
    const scheduled = buildModeToolSurface({
      capabilities: new Set(),
      environment: "external",
      scheduledRun: true,
    }).load_skill!;

    // The wrapper refuses a reserved static name before any lookup, so no database is needed.
    await expect(interactive.execute({ skill: "gws-gmail" }, {} as never)).rejects.toThrowError(
      /AGENT_GROUP_SKILL_FORBIDDEN/u,
    );
    expect(interactive.description).not.toMatch(/недоступен/iu);
    expect(scheduled.description).toMatch(/недоступен/iu);
  });

  it("overrides native workspace file tools only in the external group surface", () => {
    const surface = buildModeToolSurface({
      capabilities: new Set(),
      environment: "external",
    });

    for (const nativeTool of ["glob", "grep", "read_file", "write_file"]) {
      expect(surface).toHaveProperty(nativeTool);
      expect(buildModeToolSurface({ environment: "private" })).not.toHaveProperty(nativeTool);
      expect(buildModeToolSurface({ environment: "family" })).not.toHaveProperty(nativeTool);
    }
    expect(surface).toHaveProperty("bash");
  });

  it("emits no application tool outside the effective allowlist", () => {
    const applicationNames = new Set([...TRUSTED_MODE_TOOL_NAMES, ...PRIVATE_ONLY_TOOL_NAMES, ...FAMILY_ONLY_TOOL_NAMES]);
    const grantable = new Set<string>([...EXTERNAL_GROUP_TOOL_NAMES.map((name) => name.replace(/\..*$/u, ""))]);
    const alwaysExternal = new Set(["manage_behavior_preference", "read_profile_view"]);

    for (const emitted of names({
      capabilities: new Set(),
      environment: "external",
    })) {
      expect(applicationNames.has(emitted) && !grantable.has(emitted) && !alwaysExternal.has(emitted)).toBe(false);
    }
  });

  it("emits a granted capability but always denies provider-native search", () => {
    expect(
      names({
        capabilities: new Set(["remember"]),
        environment: "external",
      }),
    ).toContain("remember");
    expect(names({ capabilities: new Set(), environment: "external" })).toContain("web_search");
    // A granted provider web_search releases Eve's own descriptor instead of a denial stub.
    expect(names({ capabilities: new Set(["web_search"]), environment: "external" })).not.toContain("web_search");
    expect(names({ capabilities: new Set(["web_search"]), environment: "external", scheduledRun: true } as never)).toContain("web_search");
    expect(
      names({
        capabilities: new Set(["web_fetch"]),
        environment: "external",
      }),
    ).toContain("web_fetch");
  });

  it("surfaces constrained group file removal only when explicitly allowed", () => {
    expect(names({ capabilities: new Set(), environment: "external" })).not.toContain("remove_group_file");
    expect(
      names({
        capabilities: new Set(["remove_group_file"]),
        environment: "external",
      }),
    ).toContain("remove_group_file");
  });

  it("surfaces Telegram text attachment import only when explicitly allowed", () => {
    expect(names({ capabilities: new Set(), environment: "external" })).not.toContain("import_telegram_attachment");
    expect(
      names({
        capabilities: new Set(["import_telegram_attachment"]),
        environment: "external",
      }),
    ).toContain("import_telegram_attachment");
  });

  it("keeps external tool descriptions free of artificial punctuation", () => {
    const surface = buildModeToolSurface({
      capabilities: new Set(EXTERNAL_GROUP_TOOL_NAMES),
      environment: "external",
    });
    const descriptions = Object.values(surface)
      .map(({ description }) => description)
      .join("\n");

    expect(descriptions).not.toMatch(/[—–«»]/u);
  });

  it("denies Telegram attachment import after its external capability is revoked", async () => {
    const surface = buildModeToolSurface({
      capabilities: new Set(["import_telegram_attachment"]),
      environment: "external",
    });
    const staleContext = {
      session: { auth: externalAuth(["import_telegram_attachment"]) },
    } as never;

    await expect(
      surface.import_telegram_attachment!.execute(
        {
          attachmentId: "00000000-0000-4000-8000-000000000099",
        },
        staleContext,
      ),
    ).rejects.toThrowError(/AGENT_GROUP_TOOL_FORBIDDEN/u);
    expect(loadCurrentExternalGroupCapabilities).toHaveBeenCalledWith({
      familyId: "family-1",
      groupId: "group-1",
    });
  });

  it("denies every framework built-in an external group must not reach", async () => {
    const surface = buildModeToolSurface({
      capabilities: new Set(),
      environment: "external",
    });

    for (const toolName of ["agent", "ask_question", "bash", "todo", "web_fetch"]) {
      await expect(surface[toolName]!.execute({}, {} as never), `${toolName} must be denied`).rejects.toThrowError(/AGENT_GROUP_TOOL_FORBIDDEN/);
    }
  });

  it("denies a capability revoked after descriptor resolution despite a stale auth grant", async () => {
    const surface = buildModeToolSurface({
      capabilities: new Set(["remember"]),
      environment: "external",
    });
    const staleContext = {
      session: { auth: externalAuth(["remember"]) },
    } as never;

    await expect(surface.remember!.execute({}, staleContext)).rejects.toThrowError(/AGENT_GROUP_TOOL_FORBIDDEN/);
    expect(loadCurrentExternalGroupCapabilities).toHaveBeenCalledWith({
      familyId: "family-1",
      groupId: "group-1",
    });
  });

  it.each(["deleted", "retyped"])("denies a descriptor resolved before the group is %s", async () => {
    const surface = buildModeToolSurface({
      capabilities: new Set(["send_workspace_file"]),
      environment: "external",
    });
    const staleContext = {
      session: { auth: externalAuth(["send_workspace_file"]) },
    } as never;

    // The live repository represents both a missing row and a non-external row as deny-all.
    loadCurrentExternalGroupCapabilities.mockResolvedValueOnce(new Set());

    await expect(surface.send_workspace_file!.execute({}, staleContext)).rejects.toThrowError(/AGENT_GROUP_TOOL_FORBIDDEN/);
  });

  it("fails closed when execution-time policy lookup fails", async () => {
    const surface = buildModeToolSurface({
      capabilities: new Set(["remember"]),
      environment: "external",
    });
    const staleContext = {
      session: { auth: externalAuth(["remember"]) },
    } as never;
    loadCurrentExternalGroupCapabilities.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(surface.remember!.execute({}, staleContext)).rejects.toMatchObject({
      contract: {
        code: "AGENT_TOOL_DEPENDENCY_FAILED",
        retryable: false,
        sideEffectStatus: "unknown",
      },
    });
  });

  it("enforces action-level capabilities inside manage_memory", async () => {
    const surface = buildModeToolSurface({
      capabilities: new Set(["manage_memory.undo"]),
      environment: "external",
    });
    const context = {
      session: { auth: externalAuth(["manage_memory.undo"]) },
    } as never;
    loadCurrentExternalGroupCapabilities.mockResolvedValueOnce(new Set(["manage_memory.undo"]));

    expect(surface).toHaveProperty("manage_memory");
    const schema = surface.manage_memory!.inputSchema as z.ZodType;
    expect(schema.safeParse({ action: "undo", memoryRef: "mem_0123456789abcdef0123456789abcdef" }).success)
      .toBe(true);
    expect(schema.safeParse({ action: "delete", memoryRef: "mem_0123456789abcdef0123456789abcdef" }).success)
      .toBe(false);
    expect(surface.manage_memory!.description).toContain('"action":"undo"');
    expect(surface.manage_memory!.description).not.toContain('"action":"edit"');
    expect(surface.manage_memory!.description).not.toContain('"action":"delete"');
    await expect(surface.manage_memory!.execute({ action: "delete", id: "00000000-0000-4000-8000-000000000001" }, context)).rejects.toThrowError(/AGENT_GROUP_TOOL_FORBIDDEN/);
  });

  it("keeps memory-thread lifecycle action-level and re-checks the live external policy", async () => {
    const surface = buildModeToolSurface({
      capabilities: new Set(["manage_memory_thread.complete"]),
      environment: "external",
    });
    const revoked = { session: { auth: externalAuth([]) } } as never;

    expect(surface).toHaveProperty("manage_memory_thread");
    await expect(
      surface.manage_memory_thread!.execute(
        {
          action: "complete",
          authority: "current_user_statement",
          sourceEntryRefs: ["entry_0123456789abcdef0123456789abcdef"],
          threadRef: "thread_0123456789abcdef0123456789abcdef",
        },
        revoked,
      ),
    ).rejects.toThrowError(/AGENT_GROUP_TOOL_FORBIDDEN/u);
  });

  it("denies every capability when the trusted snapshot is corrupt", () => {
    expect(
      names({
        capabilities: new Set(["unknown_tool"] as unknown as ExternalGroupToolName[]),
        environment: "external",
      }),
    ).toEqual([...ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES, ...FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS, "load_skill", "manage_behavior_preference", "read_profile_view"].sort());
  });

  it("exposes only group scope in external shared-tool schemas and descriptions", () => {
    const external = buildModeToolSurface({
      capabilities: new Set(["inspect_workspace_image", "list_memories", "list_memory_threads", "remember", "send_workspace_file"]),
      environment: "external",
    });

    const inputs = {
      inspect_workspace_image: {
        path: "image.png",
        question: "Что изображено?",
      },
      list_memories: {},
      list_memory_threads: {},
      remember: {
        basis: "agent_inferred",
        content: "Проверка",
        kind: "fact",
        sensitivity: "normal",
        subject: { kind: "current_author" },
      },
      send_workspace_file: { path: "result.pdf", presentation: "document" },
    } as const;
    for (const [toolName, input] of Object.entries(inputs)) {
      const tool = external[toolName]!;
      const schema = tool.inputSchema as z.ZodType;
      expect(schema.safeParse({ ...input, scope: "group" }).success, toolName).toBe(true);
      expect(schema.safeParse({ ...input, scope: "personal" }).success, toolName).toBe(false);
      expect(schema.safeParse({ ...input, scope: "family" }).success, toolName).toBe(false);
      expect(tool.description, toolName).not.toMatch(/personal|family/iu);
      expect(tool.description, toolName).toMatch(/group|групп/iu);
    }

    const trustedRemember = buildModeToolSurface({
      environment: "private",
    }).remember!;
    const trustedSchema = trustedRemember.inputSchema as z.ZodType;
    expect(
      trustedSchema.safeParse({
        basis: "agent_inferred",
        content: "Проверка",
        kind: "fact",
        scope: "personal",
        sensitivity: "normal",
        subject: { kind: "current_author" },
      }).success,
    ).toBe(true);
  });
});
