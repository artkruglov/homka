/** manage_shared_tasks gives the model a ready board with every list, so it never retells tasks. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  timezone: vi.fn(async () => "Europe/Moscow"),
}));
vi.mock("./shared-task-repository.js", () => ({ sharedTaskRepository: { execute: mocks.execute } }));
vi.mock("./current-time-repository.js", () => ({ currentTimeRepository: { findTurnTimezone: mocks.timezone } }));
vi.mock("./memory-context.js", () => ({
  requireMemoryAuthorization: () => ({ familyId: "family-1", userId: "user-1" }),
}));

import manageSharedTasks from "./tools/manage_shared_tasks.js";

const row = (title: string, listName: string) => ({
  dueAt: null, dueOn: null, id: title, kind: "task", listName, source: "Личное", status: "accepted", title, version: 1,
});
const context = { callId: "call-1", session: { id: "session-1" } } as never;

describe("manage_shared_tasks list board", () => {
  beforeEach(() => mocks.execute.mockReset());

  it("returns a board of every list next to the rows", async () => {
    mocks.execute.mockResolvedValue({ incomplete: false, nextCursor: null, tasks: [row("Написать подрядчику", "Работа"), row("Отвезти машину", "Дом")] });

    const result = await manageSharedTasks.execute({ action: "list" } as never, context) as { board: string; tasks: unknown[] };

    expect(result.tasks).toHaveLength(2);
    expect(result.board).toContain("<telegram-keep-open>");
    expect(result.board).toContain("**Дом · 1**\n• Отвезти машину");
    expect(result.board).toContain("**Работа · 1**\n• Написать подрядчику");
  });

  it("adds no board to a change", async () => {
    mocks.execute.mockResolvedValue({ replayed: false, task: row("Дело", "Дом") });

    expect(await manageSharedTasks.execute({ action: "create", title: "Дело" } as never, context)).not.toHaveProperty("board");
  });
});
