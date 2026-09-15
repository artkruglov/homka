import { describe, expect, it } from "vitest";
import { nextSharedTaskStatus, sharedTaskInput } from "./shared-tasks.js";

describe("shared task lifecycle", () => {
  it("only the assignee can accept, decline or finish an assignment", () => {
    expect(nextSharedTaskStatus("proposed", "accept", true, false)).toBe("accepted");
    expect(nextSharedTaskStatus("proposed", "decline", true, false)).toBe("declined");
    expect(nextSharedTaskStatus("accepted", "complete", true, false)).toBe("completed");
    for (const action of ["accept", "decline", "complete"] as const) {
      expect(() => nextSharedTaskStatus("proposed", action, false, true)).toThrow(/AGENT_TASK_TRANSITION_DENIED/);
    }
  });
  it("requires acceptance before completion and supports cancellation by the proposer", () => {
    expect(() => nextSharedTaskStatus("proposed", "complete", true, false)).toThrow();
    expect(nextSharedTaskStatus("proposed", "cancel", false, true)).toBe("cancelled");
    expect(() => nextSharedTaskStatus("completed", "cancel", true, true)).toThrow();
  });
  it("rejects model supplied identities and contradictory action fields", () => {
    expect(sharedTaskInput.safeParse({ action: "create", title: "Milk", userId: "someone" }).success).toBe(false);
    expect(sharedTaskInput.safeParse({ action: "accept", id: "bad", title: "Changed" }).success).toBe(false);
    expect(sharedTaskInput.safeParse({ action: "create", title: "Milk", dueAt: "tomorrow" }).success).toBe(false);
    expect(sharedTaskInput.safeParse({ action: "list", assigneeRef: "someone" }).success).toBe(false);
  });
});


describe("life planning input", () => {
  it("accepts ideas and bounded planning windows without invented deadlines", () => {
    expect(sharedTaskInput.safeParse({action:"create",title:"Try pottery",kind:"idea",listName:"For myself"}).success).toBe(true);
    expect(sharedTaskInput.safeParse({action:"plan",id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",plannedFrom:"2026-10-01",plannedUntil:"2026-10-31"}).success).toBe(true);
  });
  it("rejects automatic obligations for ideas, and malformed or reversed dates", () => {
    expect(sharedTaskInput.safeParse({action:"create",title:"Pottery",kind:"idea",dueAt:"2026-10-01T10:00:00Z"}).success).toBe(false);
    expect(sharedTaskInput.safeParse({action:"plan",id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",plannedFrom:"2026-02-30",plannedUntil:"2026-03-01"}).success).toBe(false);
    expect(sharedTaskInput.safeParse({action:"plan",id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",plannedFrom:"2026-10-31",plannedUntil:"2026-10-01"}).success).toBe(false);
  });
  it("requires a version for editing and does not accept a new audience", () => {
    expect(sharedTaskInput.safeParse({action:"update",id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",title:"Changed"}).success).toBe(false);
    expect(sharedTaskInput.safeParse({action:"update",id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",version:1,listName:"Home",scope:"family"}).success).toBe(false);
  });
});
