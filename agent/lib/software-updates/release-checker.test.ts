/**
 * Application software update checker tests.
 *
 * Constructs covered:
 * - No owner means no durable proposal and no Telegram delivery.
 * - A unique target version creates and delivers exactly one proposal.
 * - Existing target versions suppress all repeated prompts.
 */
import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createSoftwareUpdateChecker, softwareUpdatesEnabled } from "./release-checker.js";
import type { SoftwareUpdateManifest } from "./types.js";

const manifest: SoftwareUpdateManifest = {
  commitSha: "b".repeat(40),
  composeSha256: "c".repeat(64),
  images: {
    app: `ghcr.io/nyxandro/osinara-app@sha256:${"a".repeat(64)}`,
    cliProxy: `ghcr.io/nyxandro/osinara-cli-proxy@sha256:${"a".repeat(64)}`,
    edge: `ghcr.io/nyxandro/osinara-edge@sha256:${"a".repeat(64)}`,
    sandboxEgressProxy:
      `ghcr.io/nyxandro/osinara-sandbox-egress-proxy@sha256:${"a".repeat(64)}`,
    sandboxRunner: `ghcr.io/nyxandro/osinara-sandbox-runner@sha256:${"a".repeat(64)}`,
    sandboxRuntime: `ghcr.io/nyxandro/osinara-sandbox-runtime@sha256:${"a".repeat(64)}`,
  },
  schemaVersion: 1,
  version: "0.2.0",
};
const release = {
  manifest,
  releaseUrl: "https://github.com/nyxandro/osinara/releases/tag/v0.2.0",
  version: "0.2.0",
};
const owner = {
  familyId: "family-1",
  quietEnd: null,
  quietStart: null,
  telegramUserId: "101",
  timezone: "UTC",
  userId: "owner-1",
};

function dependencies() {
  return {
    authorizeInitiative: vi.fn().mockResolvedValue({ allowed: true }),
    createCallbackToken: vi.fn(() => "callback-secret"),
    recordInitiative: vi.fn().mockResolvedValue(undefined),
    currentVersion: "0.1.0",
    deliverProposal: vi.fn().mockResolvedValue(undefined),
    releaseClient: { latestNewerThan: vi.fn().mockResolvedValue(release) },
    repository: {
      findCurrentOwner: vi.fn().mockResolvedValue(owner),
      prepareProposal: vi.fn().mockResolvedValue({ proposalId: "proposal-1", status: "created" }),
    },
  };
}

describe("software update checker", () => {
  it("manual installations do not fetch releases, write proposals or send messages", async () => {
    const values = dependencies();
    const check = createSoftwareUpdateChecker({ ...values, enabled: () => false });
    await expect(check()).resolves.toBe("disabled");
    expect(values.releaseClient.latestNewerThan).not.toHaveBeenCalled();
    expect(values.repository.findCurrentOwner).not.toHaveBeenCalled();
    expect(values.repository.prepareProposal).not.toHaveBeenCalled();
    expect(values.deliverProposal).not.toHaveBeenCalled();
  });

  it("requires an explicit valid update mode", () => {
    expect(softwareUpdatesEnabled(undefined)).toBe(true);
    expect(softwareUpdatesEnabled("upstream")).toBe(true);
    expect(softwareUpdatesEnabled("manual")).toBe(false);
    expect(() => softwareUpdatesEnabled("manul")).toThrow("AGENT_SOFTWARE_UPDATE_MODE_INVALID");
  });

  it("holds the proposal whenever the person is not to be written to now", async () => {
    // Заявка не готовится: у неё свой токен и своя строка, а предложение подождёт следующей
    // проверки через шесть часов — обновление не срочнее сна и не важнее просьбы не писать.
    for (const reason of ["quiet_hours", "muted", "daily_limit", "unanswered"] as const) {
      const values = dependencies();
      values.authorizeInitiative.mockResolvedValue({ allowed: false, reason });
      await expect(createSoftwareUpdateChecker(values)()).resolves.toBe("held");
      expect(values.repository.prepareProposal).not.toHaveBeenCalled();
      expect(values.deliverProposal).not.toHaveBeenCalled();
      expect(values.recordInitiative).not.toHaveBeenCalled();
    }
  });

  it("counts a proposal against the day only once it is delivered", async () => {
    const values = dependencies();
    await expect(createSoftwareUpdateChecker(values)()).resolves.toBe("proposed");
    expect(values.recordInitiative).toHaveBeenCalledWith(owner);
  });

  it("does nothing when no current owner exists", async () => {
    const values = dependencies();
    values.repository.findCurrentOwner.mockResolvedValue(null);
    const check = createSoftwareUpdateChecker(values);

    await expect(check()).resolves.toBe("no_owner");

    expect(values.releaseClient.latestNewerThan).toHaveBeenCalledWith("0.1.0");
    expect(values.repository.prepareProposal).not.toHaveBeenCalled();
    expect(values.deliverProposal).not.toHaveBeenCalled();
  });

  it("prepares token hash durably before delivering one proposal", async () => {
    const values = dependencies();
    const check = createSoftwareUpdateChecker(values);

    await expect(check()).resolves.toBe("proposed");

    expect(values.repository.prepareProposal).toHaveBeenCalledWith({
      callbackTokenHash: createHash("sha256").update("callback-secret").digest("hex"),
      owner,
      release,
    });
    expect(values.deliverProposal).toHaveBeenCalledWith({
      callbackToken: "callback-secret",
      owner,
      proposalId: "proposal-1",
      release,
    });
  });

  it("does not redeliver an existing target version", async () => {
    const values = dependencies();
    values.repository.prepareProposal.mockResolvedValue({ status: "duplicate" });
    const check = createSoftwareUpdateChecker(values);

    await expect(check()).resolves.toBe("duplicate");

    expect(values.deliverProposal).not.toHaveBeenCalled();
  });
});
