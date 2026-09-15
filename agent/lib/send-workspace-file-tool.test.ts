/**
 * Workspace file tool Telegram projection tests.
 *
 * Constructs covered:
 * - A confirmed group file delivery is projected into the timeline with session ownership.
 * - The exact Telegram media message receives a reply continuation route.
 * - Projection failures after confirmed delivery never invite a duplicate send.
 * - Delivery-journal failures after Telegram confirmation preserve completed side-effect semantics.
 * - Bytes already delivered to this chat in this turn are reported, not sent again.
 */
import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "./app-error.js";

const mocks = vi.hoisted(() => ({
  destination:vi.fn(),
  audience:vi.fn(),
  begin: vi.fn(),
  complete: vi.fn(),
  deliver: vi.fn(),
  fail: vi.fn(),
  recordAgentResponse: vi.fn(),
  registerTelegramMessageRoutes: vi.fn(),
}));

vi.mock("./workspaces/workspace-file-destination.js",()=>({requireWorkspaceFileDestination:mocks.destination}));

vi.mock("./spaces/space-delivery-authorization.js",()=>({authorizeSpaceDelivery:mocks.audience}));

vi.mock("./attachments/telegram-workspace-file-delivery.js", () => ({
  deliverWorkspaceFile: mocks.deliver,
}));
vi.mock("./workspaces/workspace-file-delivery-repository.js", () => ({
  workspaceFileDeliveryRepository: {
    begin: mocks.begin,
    complete: mocks.complete,
    fail: mocks.fail,
  },
}));
vi.mock("./telegram-group-journal-repository.js", () => ({
  telegramGroupJournalRepository: { recordAgentResponse: mocks.recordAgentResponse },
}));
vi.mock("./sessions/session-context.js", () => ({
  applicationSessionId: () => "app-session-1",
  registerTelegramMessageRoutes: mocks.registerTelegramMessageRoutes,
}));

import sendWorkspaceFile from "./tools/send_workspace_file.js";
import {sendAuthorizedWorkspaceFile} from "./workspaces/workspace-file-sender.js";
import {requireWorkspaceAuthorization} from "./workspaces/workspace-context.js";

function context(): ToolContext {
  const caller = {
    attributes: {
      applicationSessionId: "app-session-1",
      familyId: "family-1",
      groupId: "group-1",
      groupType: "family_private",
      role: "member",
      telegramChatId: "-1001",
      telegramChatType: "supergroup",
      telegramForumTopicId: "42",
      telegramMessageThreadId: "42",
      telegramTimelineEntryId: "00000000-0000-4000-8000-000000000010",
    },
    authenticator: "telegram",
    principalId: "user-1",
    principalType: "user" as const,
  };
  return {
    callId: "call-1",
    session: {
      auth: { current: caller, initiator: caller },
      id: "eve-session-1",
      turn: { id: "turn-1", sequence: 1 },
    },
  } as unknown as ToolContext;
}

describe("send_workspace_file group projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.destination.mockResolvedValue(undefined);
    mocks.audience.mockResolvedValue({allowed:true});
    mocks.begin.mockResolvedValue({
      bytes: Buffer.from("image"),
      file: {
        contentSha256: "sha256",
        mediaType: "image/png",
        path: "screens/facade.png",
        scope: "family",
        size: 5,
      },
      status: "reserved",
      workspaceId: "workspace-1",
    });
    mocks.deliver.mockResolvedValue({ telegramMessageId: "446" });
    mocks.recordAgentResponse.mockResolvedValue({ entryId: "entry-1", sequenceId: "20" });
  });

  it("records and routes a confirmed tool-delivered photo", async () => {
    await sendWorkspaceFile.execute({
      caption: "Фасад ресторана",
      path: "screens/facade.png",
      presentation: "photo",
      scope: "family",
    }, context());

    expect(mocks.complete).toHaveBeenCalledWith("call-1", "446");
    expect(mocks.recordAgentResponse).toHaveBeenCalledWith(expect.objectContaining({
      applicationSessionId: "app-session-1",
      attachment: expect.objectContaining({ fileName: "facade.png", kind: "photo" }),
      contentText: "Фасад ресторана",
      groupId: "group-1",
      messageThreadId: "42",
      telegramMessageIds: ["446"],
    }));
    expect(mocks.registerTelegramMessageRoutes).toHaveBeenCalledWith({
      applicationSessionId: "app-session-1",
      chatId: "-1001",
      messageIds: ["446"],
      messageThreadId: 42,
    });
  });

  // Upstream 61363db: one picture reached a chat as a photo from generate_image and again as a
  // document from a second call in the same turn. The call id differs, so only the turn and the
  // content hash can recognise the repeat.
  it("reports bytes already sent this turn instead of sending them again", async () => {
    const file = {
      contentSha256: "sha256",
      mediaType: "image/png",
      path: "screens/facade.png",
      scope: "family",
      size: 5,
    };
    mocks.begin.mockReset();
    mocks.begin
      .mockResolvedValueOnce({ bytes: Buffer.from("image"), file, status: "reserved", workspaceId: "workspace-1" })
      .mockResolvedValueOnce({
        bytes: Buffer.from("image"), file, status: "duplicate", telegramMessageId: "446",
        workspaceId: "workspace-1",
      });
    const again = context();
    (again as unknown as { callId: string }).callId = "call-2";

    await sendWorkspaceFile.execute({ path: "screens/facade.png", presentation: "photo", scope: "family" }, context());
    await expect(sendWorkspaceFile.execute({
      path: "screens/facade.png",
      presentation: "document",
      scope: "family",
    }, again)).resolves.toMatchObject({
      alreadySent: true,
      delivered: true,
      replayed: false,
      sideEffectStatus: "completed",
      telegramMessageId: "446",
    });

    expect(mocks.begin).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({
      operationKey: "call-2",
      turnId: "eve-session-1:turn-1",
    }));
    expect(mocks.deliver).toHaveBeenCalledTimes(1);
    expect(mocks.recordAgentResponse).toHaveBeenCalledTimes(1);
    expect(mocks.registerTelegramMessageRoutes).toHaveBeenCalledTimes(1);
  });

  it("repairs timeline and route projection when a confirmed delivery step replays", async () => {
    mocks.begin.mockResolvedValue({
      bytes: Buffer.from("image"),
      file: {
        contentSha256: "sha256",
        mediaType: "image/png",
        path: "screens/facade.png",
        scope: "family",
        size: 5,
      },
      status: "completed",
      telegramMessageId: "446",
      workspaceId: "workspace-1",
    });

    await expect(sendWorkspaceFile.execute({
      caption: "Фасад ресторана",
      path: "screens/facade.png",
      presentation: "photo",
      scope: "family",
    }, context())).resolves.toMatchObject({ delivered: true, replayed: true });

    expect(mocks.deliver).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.recordAgentResponse).toHaveBeenCalled();
    expect(mocks.registerTelegramMessageRoutes).toHaveBeenCalled();
  });

  it("returns confirmed delivery with an explicit projection warning instead of throwing", async () => {
    mocks.recordAgentResponse.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(sendWorkspaceFile.execute({
      caption: "Фасад ресторана",
      path: "screens/facade.png",
      presentation: "photo",
      scope: "family",
    }, context())).resolves.toMatchObject({
      delivered: true,
      projectionCompleted: false,
      retryable: false,
      sideEffectStatus: "completed",
    });

    expect(mocks.deliver).toHaveBeenCalledTimes(1);
    expect(mocks.registerTelegramMessageRoutes).not.toHaveBeenCalled();
  });

  it("does not retry Telegram when durable completion fails after confirmed delivery", async () => {
    mocks.complete.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(sendWorkspaceFile.execute({
      path: "screens/facade.png",
      presentation: "photo",
      scope: "family",
    }, context())).resolves.toMatchObject({
      delivered: true,
      persistenceCompleted: false,
      retryable: false,
      sideEffectStatus: "completed",
      telegramMessageId: "446",
    });

    expect(mocks.deliver).toHaveBeenCalledTimes(1);
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });

  it("keeps an ambiguous Telegram delivery reserved for explicit recovery", async () => {
    mocks.deliver.mockRejectedValueOnce(new AppError(
      "AGENT_WORKSPACE_FILE_DELIVERY_AMBIGUOUS",
      "Telegram не подтвердил отправку файла",
    ));

    await expect(sendWorkspaceFile.execute({
      path: "screens/facade.png",
      presentation: "photo",
      scope: "family",
    }, context())).rejects.toThrowError(/AGENT_WORKSPACE_FILE_DELIVERY_AMBIGUOUS/u);

    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.fail).not.toHaveBeenCalled();
  });

  it("validates the forum topic before starting an external delivery", async () => {
    const invalidContext = context();
    (invalidContext.session.auth.current!.attributes as Record<string, unknown>)
      .telegramForumTopicId = "0";

    await expect(sendWorkspaceFile.execute({
      path: "screens/facade.png",
      presentation: "photo",
      scope: "family",
    }, invalidContext)).rejects.toThrowError(/AGENT_TELEGRAM_FORUM_TOPIC_INVALID/u);

    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.deliver).not.toHaveBeenCalled();
  });
  it("projects a backend delivery without inventing a live agent session", async () => {
    await expect(sendAuthorizedWorkspaceFile({path:"screens/facade.png",presentation:"document",scope:"family"}, {
      auth:requireWorkspaceAuthorization(context()),target:{chatId:"-1001",messageThreadId:42},
      operationKey:"video-delivery:job",projection:{applicationSessionId:null,forumTopicId:"42",replyToEntryId:null},
      beforeSend:async()=>{},
    })).resolves.toMatchObject({delivered:true});
    expect(mocks.complete).toHaveBeenCalledWith("video-delivery:job","446");
    expect(mocks.recordAgentResponse).toHaveBeenCalledWith(expect.objectContaining({applicationSessionId:null,messageThreadId:"42"}));
    expect(mocks.registerTelegramMessageRoutes).not.toHaveBeenCalled();
  });
  it("checks a background lease again after obtaining file bytes and before Telegram", async () => {
    const beforeSend=vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(
      new AppError("AGENT_VIDEO_COMPLETION_LEASE_STALE","Lease expired"));
    await expect(sendAuthorizedWorkspaceFile({path:"screens/facade.png",presentation:"document",scope:"family"}, {
      auth:requireWorkspaceAuthorization(context()),target:{chatId:"-1001"},operationKey:"video-delivery:job",
      projection:{applicationSessionId:null,forumTopicId:null,replyToEntryId:null},beforeSend,
    })).rejects.toThrow("LEASE_STALE");
    expect(mocks.begin).toHaveBeenCalledTimes(1);
    expect(mocks.deliver).not.toHaveBeenCalled();
  });

  it("stops before bytes or Telegram when the audience is unproven",async()=>{
    mocks.audience.mockResolvedValueOnce({allowed:false,code:'AGENT_SPACE_DELIVERY_AUDIENCE_UNPROVEN'});
    await expect(sendWorkspaceFile.execute({path:'screens/facade.png',presentation:'photo',scope:'family'},context()))
      .rejects.toThrow('AUDIENCE_UNPROVEN');
    expect(mocks.begin).not.toHaveBeenCalled();expect(mocks.deliver).not.toHaveBeenCalled();
  });

  it.each([1,2])("stops a changed destination at check %s before Telegram",async(check)=>{
    if(check===2)mocks.destination.mockResolvedValueOnce(undefined);
    mocks.destination.mockRejectedValueOnce(new AppError('AGENT_WORKSPACE_FILE_DESTINATION_CHANGED','Moved'));
    await expect(sendWorkspaceFile.execute({path:'screens/facade.png',presentation:'photo',scope:'family'},context()))
      .rejects.toThrow('DESTINATION_CHANGED');
    expect(mocks.begin).toHaveBeenCalledTimes(check-1);
    expect(mocks.deliver).not.toHaveBeenCalled();
    expect(mocks.destination).toHaveBeenCalledWith(requireWorkspaceAuthorization(context()),'-1001');
  });

});
