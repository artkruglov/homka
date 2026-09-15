/**
 * Счётчик участников — единственный сигнал о составе, который приложение получает без патча Eve.
 *
 * Проверяется: чат не спрашивают чаще раза в минуту; молчание провайдера ничего не отзывает;
 * расхождение снимает разрешение.
 */
import { describe, expect, it, vi } from "vitest";

import { createTelegramAudienceWatch } from "./telegram-audience-watch.js";

const NOW = new Date("2026-09-11T12:00:00.000Z");
const input = {
  familyId: "00000000-0000-4000-8000-000000000001",
  groupId: "00000000-0000-4000-8000-000000000002",
  now: NOW,
  telegramChatId: "-1001",
};

function watch(options: {
  checkedAt: Date | null;
  count?: number | null;
  outcome?: "matched" | "revoked" | "unproven";
}) {
  const memberCount = vi.fn().mockResolvedValue(options.count ?? null);
  const noteCount = vi.fn().mockResolvedValue(options.outcome ?? "matched");
  return {
    memberCount,
    noteCount,
    refresh: createTelegramAudienceWatch({
      memberCount,
      noteCount,
      readProof: async () => options.checkedAt === null ? null : { checkedAt: options.checkedAt },
    }),
  };
}

describe("telegram audience watch", () => {
  it("does not ask a chat about its size more than once a minute", async () => {
    const fresh = watch({ checkedAt: new Date(NOW.getTime() - 30_000) });
    await expect(fresh.refresh(input)).resolves.toBe("skipped");
    expect(fresh.memberCount).not.toHaveBeenCalled();
  });

  it("asks nothing about a chat that has no proof at all", async () => {
    const none = watch({ checkedAt: null });
    await expect(none.refresh(input)).resolves.toBe("skipped");
    expect(none.memberCount).not.toHaveBeenCalled();
  });

  it("keeps the existing permission when the provider says nothing", async () => {
    const silent = watch({ checkedAt: new Date(NOW.getTime() - 120_000), count: null });
    await expect(silent.refresh(input)).resolves.toBe("skipped");
    expect(silent.memberCount).toHaveBeenCalledOnce();
    expect(silent.noteCount).not.toHaveBeenCalled();
  });

  it("revokes the permission when the count no longer matches", async () => {
    const changed = watch({
      checkedAt: new Date(NOW.getTime() - 120_000), count: 4, outcome: "revoked",
    });
    await expect(changed.refresh(input)).resolves.toBe("revoked");
  });
});
