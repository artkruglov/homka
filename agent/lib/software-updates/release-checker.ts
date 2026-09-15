/**
 * Application-owned proactive software update checker.
 *
 * Exports:
 * - `createSoftwareUpdateChecker`: dependency-injected latest-release proposal workflow.
 * - `runSoftwareUpdateCheck`: production six-hour schedule operation.
 * - `softwareUpdatesEnabled`: validates the installation update mode.
 */
import { createHash, randomBytes } from "node:crypto";

import { CURRENT_SOFTWARE_VERSION } from "./current-version.js";
import {
  githubSoftwareReleaseClient,
  type GitHubSoftwareReleaseClient,
} from "./github-release-client.js";
import { decideInitiative, type InitiativeDecision } from "../initiative/initiative-policy.js";
import { initiativeRepository } from "../initiative/initiative-repository.js";
import { deliverSoftwareUpdateProposal } from "./proposal-delivery.js";
import { softwareUpdateRepository } from "./repository.js";
import type {
  SoftwareUpdateRecipient,
  DeliverSoftwareUpdateProposalInput,
  SoftwareUpdateRepository,
} from "./types.js";

interface SoftwareUpdateCheckerDependencies {
  enabled?(): boolean;
  createCallbackToken(): string;
  currentVersion: string;
  authorizeInitiative(owner: SoftwareUpdateRecipient): Promise<InitiativeDecision>;
  deliverProposal(input: DeliverSoftwareUpdateProposalInput): Promise<void>;
  recordInitiative(owner: SoftwareUpdateRecipient): Promise<void>;
  releaseClient: GitHubSoftwareReleaseClient;
  repository: Pick<SoftwareUpdateRepository, "findCurrentOwner" | "prepareProposal">;
}

export type SoftwareUpdateCheckResult =
  | "disabled"
  | "duplicate"
  | "held"
  | "no_owner"
  | "no_update"
  | "proposed";

export function createSoftwareUpdateChecker(dependencies: SoftwareUpdateCheckerDependencies) {
  return async function checkSoftwareUpdate(): Promise<SoftwareUpdateCheckResult> {
    if (dependencies.enabled && !dependencies.enabled()) return "disabled";
    const release = await dependencies.releaseClient.latestNewerThan(dependencies.currentVersion);
    if (!release) return "no_update";
    const owner = await dependencies.repository.findCurrentOwner();
    if (!owner) return "no_owner";
    // Предложение обновления это разговор, начатый программой, и он проходит общую дверь:
    // тихие часы, выключатель, предел на сутки и пауза после молчания. Заявка с собственным
    // токеном при отказе не готовится вовсе — предложение подождёт следующей проверки.
    const decision = await dependencies.authorizeInitiative(owner);
    if (!decision.allowed) {
      console.info(JSON.stringify({
        code: "AGENT_SOFTWARE_UPDATE_PROPOSAL_HELD", reason: decision.reason,
      }));
      return "held";
    }

    // Only the hash crosses the durable boundary; the random token exists until initial delivery.
    const callbackToken = dependencies.createCallbackToken();
    const prepared = await dependencies.repository.prepareProposal({
      callbackTokenHash: createHash("sha256").update(callbackToken).digest("hex"),
      owner,
      release,
    });
    if (prepared.status === "duplicate") return "duplicate";
    await dependencies.deliverProposal({
      callbackToken,
      owner,
      proposalId: prepared.proposalId,
      release,
    });
    // Запись идёт после доставки: неотправленное предложение не тратит предел суток.
    await dependencies.recordInitiative(owner);
    return "proposed";
  };
}

export function softwareUpdatesEnabled(mode: string | undefined): boolean {
  if (mode === undefined || mode === "upstream") return true;
  if (mode === "manual") return false;
  throw new Error("AGENT_SOFTWARE_UPDATE_MODE_INVALID: Ожидается manual или upstream");
}

export const runSoftwareUpdateCheck = createSoftwareUpdateChecker({
  enabled: () => softwareUpdatesEnabled(process.env.OSINARA_SOFTWARE_UPDATES),
  createCallbackToken: () => randomBytes(24).toString("base64url"),
  currentVersion: CURRENT_SOFTWARE_VERSION,
  authorizeInitiative: async (owner) => {
    const current = await initiativeRepository.read(owner.userId, new Date());
    // Владельца нет в базе между чтением и решением: молчание безопаснее случайного сообщения.
    if (!current) return { allowed: false, reason: "muted" } as const;
    return decideInitiative(current.settings, current.state, new Date());
  },
  deliverProposal: deliverSoftwareUpdateProposal,
  recordInitiative: (owner) => initiativeRepository.record({
    familyId: owner.familyId, kind: "update_proposal", now: new Date(), userId: owner.userId,
  }),
  releaseClient: githubSoftwareReleaseClient,
  repository: softwareUpdateRepository,
});
