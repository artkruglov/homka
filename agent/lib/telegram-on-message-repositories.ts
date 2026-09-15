/**
 * Telegram inbound handler dependency contract and production adapters.
 *
 * Exports:
 * - `TelegramMessageRepositories`: explicit repository surface consumed by authorization handling.
 * - `productionTelegramMessageRepositories`: PostgreSQL, attachment, notice, and workspace adapters.
 */
import type { TelegramMessage } from "eve/channels/telegram";

import { downloadTelegramAttachment } from "./attachments/telegram-attachment-download.js";
import {
  telegramGroupAttachmentRepository,
  type TelegramGroupAttachmentRepository,
} from "./attachments/telegram-group-attachment-repository.js";
import {
  createTelegramWorkspaceAttachmentImporter,
  type StoredTelegramAttachment,
} from "./attachments/telegram-workspace-attachments.js";
import { conversationRepository } from "./conversation-repository.js";
import { resolveTelegramChatMode, resolveTurnSpace } from "./spaces/turn-space-selection.js";
import { conversationTimelineRepository } from "./conversation-timeline-repository.js";
import { currentTimeRepository } from "./current-time-repository.js";
import { initiativeRepository } from "./initiative/initiative-repository.js";
import { familyRepository, type FamilyRepository } from "./family-repository.js";
import { profileProjectionPolicyRepository } from "./profile-projection-policy-repository.js";
import { proactiveDeliveryRepository } from "./proactive-deliveries/proactive-delivery-repository.js";
import { sessionRepository } from "./sessions/session-repository.js";
import {
  telegramGroupJournalRepository,
  type TelegramGroupJournalRepository,
} from "./telegram-group-journal-repository.js";
import {
  telegramGroupTurnContextPreparer,
  type TelegramGroupTurnContextPreparer,
} from "./telegram-group-turn-context.js";
import {
  telegramHitlApprovalRepository,
  type TelegramHitlApprovalRepository,
} from "./telegram-hitl/approval-repository.js";
import {
  productionMemoryThreadNotices,
  type MemoryThreadNoticeDeliveryRepository,
} from "./telegram-memory-thread-notice.js";
import { telegramRepository, type TelegramRepository } from "./telegram-repository.js";
import { workspaceBinaryRepository } from "./workspaces/workspace-binary-repository.js";
import { inspectWorkspaceImage } from "./workspaces/workspace-image-inspection.js";
import type {
  WorkspaceAuthorization,
  WorkspaceScope,
} from "./workspaces/workspace-repository.js";
import { memoryReviewRepository } from "./memory-review/memory-review-repository.js";
import { buildTelegramMemoryContext } from "./telegram-turn-memory-context.js";

export interface TelegramMessageRepositories {
  attachmentReferences: Pick<TelegramGroupAttachmentRepository, "captureReplyTarget" | "record">;
  attachments: {
    inspect: typeof inspectWorkspaceImage;
    persist(input: {
      attachments: readonly TelegramMessage["attachments"][number][];
      auth: WorkspaceAuthorization;
      chatId: string;
      messageId: string;
      scope: WorkspaceScope;
    }): Promise<StoredTelegramAttachment[]>;
  };
  conversations: Pick<
    typeof conversationRepository,
    "getByChatId" | "getByGroupId" | "syncTimelineParticipants"
  >;
  currentTime: Pick<typeof currentTimeRepository, "findTurnTimezone">;
  /** Retrieved memory for the accepted turn, delivered as context rather than as instructions. */
  memoryContext: typeof buildTelegramMemoryContext;
  threadNotices: MemoryThreadNoticeDeliveryRepository;
  profilePolicies: Pick<
    typeof profileProjectionPolicyRepository,
    "claimPendingGroupNotice" | "markGroupNoticePresented"
  >;
  family: Pick<FamilyRepository, "claimInvitation">;
  groupContext: { prepare: TelegramGroupTurnContextPreparer };
  hitl: Pick<TelegramHitlApprovalRepository, "authorizeReply">;
  /** Слово человека снимает паузу: пока он молчит, бот не начинает следующий разговор. */
  initiative: Pick<typeof initiativeRepository, "markAnswered">;
  journal: Pick<TelegramGroupJournalRepository, "findSeriesSequences" | "record">;
  memoryReview: Pick<
    typeof memoryReviewRepository,
    "failInteractivePreparation" | "observePassiveMessage" | "prepareInteractiveTurn"
  >;
  proactiveDeliveries: Pick<typeof proactiveDeliveryRepository, "listPendingContext">;
  session: Pick<typeof sessionRepository, "hasRoute" | "prepareTurn">;
  spaces: {
    resolveTelegramChatMode: typeof resolveTelegramChatMode;
    resolveTurnSpace: typeof resolveTurnSpace;
  };
  telegram: TelegramRepository;
  timeline: Pick<typeof conversationTimelineRepository, "recordInbound">;
}

// Production wiring stays separate from authorization flow so tests can replace every side effect.
export const productionTelegramMessageRepositories = {
  attachmentReferences: telegramGroupAttachmentRepository,
  attachments: { ...createTelegramWorkspaceAttachmentImporter({
    download: downloadTelegramAttachment,
    writeBinary: workspaceBinaryRepository.writeBinary,
  }), inspect: inspectWorkspaceImage },
  conversations: conversationRepository,
  currentTime: currentTimeRepository,
  memoryContext: buildTelegramMemoryContext,
  profilePolicies: profileProjectionPolicyRepository,
  family: familyRepository,
  groupContext: { prepare: telegramGroupTurnContextPreparer },
  hitl: telegramHitlApprovalRepository,
  initiative: initiativeRepository,
  journal: telegramGroupJournalRepository,
  memoryReview: memoryReviewRepository,
  proactiveDeliveries: proactiveDeliveryRepository,
  session: sessionRepository,
  spaces: { resolveTelegramChatMode, resolveTurnSpace },
  telegram: telegramRepository,
  timeline: conversationTimelineRepository,
  threadNotices: productionMemoryThreadNotices,
} satisfies TelegramMessageRepositories;
