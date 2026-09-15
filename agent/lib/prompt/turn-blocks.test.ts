/**
 * Turn-scoped prompt block resolution tests.
 *
 * Constructs covered:
 * - Eve retains a previous turn's block when a resolver throws, so resolvers must never throw.
 * - An unresolvable environment produces an explicit fail-closed block, not a stale one.
 * - A failed external capability lookup degrades to an empty allowlist, matching execution policy.
 * - Scheduled-history instructions require the same successful application-core policy lookup.
 */
import type { SessionAuth, SessionAuthContext } from "eve/context";
import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";

import type { ExternalGroupToolName } from "../tool-policy/group-tool-catalog.js";
import {
  createModeBlockResolver,
  createPreferenceBlockResolver,
} from "./turn-blocks.js";

function auth(attributes: SessionAuthContext["attributes"]): SessionAuth {
  return {
    current: {
      attributes,
      authenticator: "telegram",
      principalId: "user-1",
      principalType: "user",
    },
    initiator: null,
  };
}

function context(
  sessionAuth: SessionAuth,
  messages: readonly ModelMessage[] = [],
  channelKind = "telegram",
) {
  return { channel: { kind: channelKind }, messages, session: { auth: sessionAuth, id: "session-1" } };
}

const privateAuth = auth({
  memoryScopes: ["personal", "family"],
  telegramActorId: "101",
  telegramActorKind: "telegram_user",
  telegramChatType: "private",
  telegramUserId: "101",
});

const externalAuth = auth({
  familyId: "family-1",
  groupId: "group-1",
  groupType: "external",
  memoryScopes: ["group"],
  role: "external",
  telegramActorId: "101",
  telegramActorKind: "telegram_user",
  telegramChatType: "supergroup",
  telegramUserId: "101",
  toolAllowlist: ["remember"],
});

const channelAuth: SessionAuth = {
  current: {
    attributes: {
      familyId: "family-1",
      groupId: "group-1",
      groupType: "external",
      memoryScopes: ["group"],
      role: "external",
      telegramActorId: "-1001000000002",
      telegramActorKind: "telegram_channel",
      telegramChatType: "supergroup",
      toolAllowlist: ["remember"],
    },
    authenticator: "telegram",
    principalId: "telegram-channel:-1001000000002",
    principalType: "service",
  },
  initiator: null,
};

const reactionPolicy = vi.fn().mockResolvedValue(null);

describe("mode block resolution", () => {
  it("resolves the verified profile for a trusted conversation", async () => {
    const resolve = createModeBlockResolver({
      loadCapabilities: vi.fn(),
      loadReactionPolicy: reactionPolicy,
    });

    const markdown = await resolve(context(privateAuth));

    expect(markdown).toContain("# Текущий режим: личный чат");
    // Прежний режим монтирует оба корня, ход с доказанной областью — только её.
    expect(markdown).toContain("/workspace/family");
    const scoped = await resolve(context(auth({
      ...privateAuth.current!.attributes,
      spaceId: "00000000-0000-4000-8000-000000000001",
      spacePolicyVersion: "3",
      spaceTitle: "Мы вдвоём",
    })));
    expect(scoped).toContain("/workspace/personal");
    expect(scoped).not.toContain("/workspace/family");
    // Человек обязан видеть, куда попадёт новая запись, не спрашивая об этом отдельно.
    expect(scoped).toContain("Активная область: Мы вдвоём");
  });

  it("returns an explicit fail-closed block instead of throwing on invalid auth", async () => {
    const resolve = createModeBlockResolver({
      loadCapabilities: vi.fn(),
      loadReactionPolicy: reactionPolicy,
    });

    const markdown = await resolve(context({ current: null, initiator: null }));

    expect(markdown).toContain("AGENT_CONVERSATION_ENVIRONMENT_INVALID");
    expect(markdown).toContain("<current_conversation_environment>");
    expect(markdown).not.toContain("# Текущий режим: личный чат");
  });

  it("degrades to an empty allowlist when the live capability lookup fails", async () => {
    const loadCapabilities = vi.fn().mockRejectedValue(new Error("database unavailable"));
    const resolve = createModeBlockResolver({
      loadCapabilities,
      loadReactionPolicy: reactionPolicy,
    });

    const markdown = await resolve(context(externalAuth));

    expect(markdown).toContain("<external_group_capabilities>");
    expect(markdown).not.toContain("`remember`");
  });

  it("omits scheduled-history instructions when application-core policy lookup fails", async () => {
    const current = auth({
      ...externalAuth.current!.attributes,
      scheduledGroupHistory: "enabled",
      scheduledRunId: "run-1",
    });
    const scheduledAuth = { ...current, initiator: current.current };
    const resolve = createModeBlockResolver({
      loadCapabilities: vi.fn().mockRejectedValue(new Error("database unavailable")),
      loadReactionPolicy: reactionPolicy,
    });

    const markdown = await resolve(context(scheduledAuth));

    expect(markdown).not.toContain("read_scheduled_group_history");
  });

  it("includes scheduled-history instructions after application-core policy resolves", async () => {
    const current = auth({
      ...externalAuth.current!.attributes,
      scheduledGroupHistory: "enabled",
      scheduledRunId: "run-1",
    });
    const scheduledAuth = { ...current, initiator: current.current };
    const resolve = createModeBlockResolver({
      loadCapabilities: vi.fn().mockResolvedValue(new Set()),
      loadReactionPolicy: reactionPolicy,
    });

    const markdown = await resolve(context(scheduledAuth));

    expect(markdown).toContain("read_scheduled_group_history");
  });

  it("omits a capability revoked from the current database policy", async () => {
    const loadCapabilities = vi.fn().mockResolvedValue(new Set<ExternalGroupToolName>());
    const resolve = createModeBlockResolver({
      loadCapabilities,
      loadReactionPolicy: reactionPolicy,
    });

    const markdown = await resolve(context(externalAuth));

    expect(loadCapabilities).toHaveBeenCalledWith({ familyId: "family-1", groupId: "group-1" });
    expect(markdown).not.toContain("`remember`");
  });

  it("intersects the verified snapshot with the current database policy", async () => {
    const loadCapabilities = vi.fn().mockResolvedValue(
      new Set<ExternalGroupToolName>(["remember", "web_fetch"]),
    );
    const resolve = createModeBlockResolver({
      loadCapabilities,
      loadReactionPolicy: reactionPolicy,
    });

    const markdown = await resolve(context(externalAuth));

    expect(markdown).toContain("`remember`");
    expect(markdown).not.toContain("`web_fetch`");
  });

  it("describes authored skills granted to the group and survives a failed grant lookup", async () => {
    const loadCapabilities = vi.fn().mockResolvedValue(new Set<ExternalGroupToolName>(["remember"]));
    const loadGrantedSkills = vi.fn()
      .mockResolvedValueOnce([{ description: "Сводка недели по чату", name: "weekly-digest" }])
      .mockRejectedValueOnce(new Error("database unavailable"));
    const resolve = createModeBlockResolver({
      loadCapabilities,
      loadGrantedSkills,
      loadReactionPolicy: reactionPolicy,
    });

    const granted = await resolve(context(externalAuth));
    expect(loadGrantedSkills).toHaveBeenCalledWith({ familyId: "family-1", groupId: "group-1" });
    expect(granted).toContain("`load_skill` с `skill=weekly-digest`: Сводка недели по чату");
    expect(granted).toContain("Effective skills: `weekly-digest`.");

    const degraded = await resolve(context(externalAuth));
    expect(degraded).toContain("`remember`");
    expect(degraded).not.toContain("weekly-digest");
  });

  it("does not describe human capabilities or skills to a channel actor", async () => {
    const loadCapabilities = vi.fn().mockResolvedValue(new Set(["remember"]));
    const resolve = createModeBlockResolver({
      loadCapabilities,
      loadReactionPolicy: reactionPolicy,
    });

    const markdown = await resolve(context(channelAuth));

    expect(loadCapabilities).not.toHaveBeenCalled();
    // The text-only channel surface must not gain a reaction it could apply to a channel post.
    expect(reactionPolicy).not.toHaveBeenCalled();
    expect(markdown).not.toContain("## Реакция вместо сообщения");
    expect(markdown).not.toContain("`remember`");
    expect(markdown).not.toContain("`load_skill`");
  });
});

describe("preference block resolution", () => {
  it("renders the one user-managed prompt of the current chat", async () => {
    const resolve = createPreferenceBlockResolver({
      authorize: () => ({
        conversationId: "conversation-1",
        sourceSequence: "1",
        telegramUserId: "101",
        timelineEntryId: "entry-1",
      }),
      get: vi.fn().mockResolvedValue({
        content: "Не добавляй шутки.",
        revision: 2,
        updatedAt: "2026-08-01T00:00:00.000Z",
      }),
    });

    const markdown = await resolve(context(privateAuth));

    expect(markdown).toContain('<chat_operational_instructions revision="2">');
    expect(markdown).toContain("Не добавляй шутки.");
  });

  it("clears the block instead of throwing when preferences cannot be read", async () => {
    const resolve = createPreferenceBlockResolver({
      authorize: () => {
        throw new Error("AGENT_MEMORY_CONTEXT_INVALID: нет области памяти");
      },
      get: vi.fn(),
    });

    expect(await resolve(context(privateAuth))).toBeNull();
  });
});
