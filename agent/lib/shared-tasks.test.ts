import { describe, expect, it } from "vitest";
import { z } from "zod";
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

describe("task registry reads", () => {
  it("reads one record by id and lists closed work only on request", () => {
    expect(sharedTaskInput.safeParse({action:"get",id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}).success).toBe(true);
    expect(sharedTaskInput.safeParse({action:"get"}).success).toBe(false);
    expect(sharedTaskInput.safeParse({action:"get",id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",status:"completed"}).success).toBe(false);
    expect(sharedTaskInput.safeParse({action:"list",view:"done"}).success).toBe(true);
  });
});

describe("batch of planner actions", () => {
  const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
  it("accepts a dictated list and a closing list as one call", () => {
    expect(sharedTaskInput.safeParse({action:"batch",items:[{action:"create",title:"Шторы"},{action:"create",title:"Продать опель",listName:"Дом"}]}).success).toBe(true);
    expect(sharedTaskInput.safeParse({action:"batch",items:[{action:"complete",id:id(1)},{action:"cancel",id:id(2)}]}).success).toBe(true);
  });
  it("rejects empty, oversized, nested, edit and duplicate batches", () => {
    expect(sharedTaskInput.safeParse({action:"batch",items:[]}).success).toBe(false);
    expect(sharedTaskInput.safeParse({action:"batch",items:Array.from({length:21},(_,i)=>({action:"create",title:`t${i}`}))}).success).toBe(false);
    expect(sharedTaskInput.safeParse({action:"batch",items:[{action:"batch",items:[]}]}).success).toBe(false);
    expect(sharedTaskInput.safeParse({action:"batch",items:[{action:"update",id:id(1),version:1,title:"x"}]}).success).toBe(false);
    expect(sharedTaskInput.safeParse({action:"batch",items:[{action:"complete",id:id(1)},{action:"cancel",id:id(1)}]}).success).toBe(false);
    expect(sharedTaskInput.safeParse({action:"batch",items:[{action:"complete",id:id(1),title:"x"}]}).success).toBe(false);
    expect(sharedTaskInput.safeParse({action:"create",title:"x",items:[]}).success).toBe(false);
  });
});

describe("planner tool schema on the wire", () => {
  it("keeps an object root without references so DeepSeek accepts the batch items", () => {
    const schema = z.toJSONSchema(sharedTaskInput, { io: "input" }) as { type?: string; properties?: Record<string, { type?: string; items?: { type?: string } }> };
    const text = JSON.stringify(schema);
    expect(schema.type).toBe("object");
    expect(text).not.toContain("$ref");
    expect(schema.properties?.items).toMatchObject({ type: "array", items: { type: "object" } });
  });
});

describe("optimistic version on status changes", () => {
  it("accepts the version the model read with list on complete, cancel and the other status actions", () => {
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    for (const action of ["complete", "cancel", "accept", "decline", "claim"]) {
      expect(sharedTaskInput.safeParse({ action, id, version: 2 }).success).toBe(true);
    }
    expect(sharedTaskInput.safeParse({ action: "batch", items: [{ action: "complete", id, version: 2 }] }).success).toBe(true);
  });
});

describe("reopening a closed task", () => {
  it("returns completed or cancelled work to the people of the task, never a declined request", () => {
    expect(nextSharedTaskStatus("completed", "reopen", true, false)).toBe("accepted");
    // Автор не может вернуть чужое поручение сразу принятым: исполнитель соглашается заново.
    expect(nextSharedTaskStatus("cancelled", "reopen", false, true)).toBe("proposed");
    expect(() => nextSharedTaskStatus("declined", "reopen", true, true)).toThrow(/AGENT_TASK_TRANSITION_DENIED/);
    expect(() => nextSharedTaskStatus("accepted", "reopen", true, true)).toThrow(/AGENT_TASK_TRANSITION_DENIED/);
    expect(() => nextSharedTaskStatus("completed", "reopen", false, false)).toThrow(/AGENT_TASK_TRANSITION_DENIED/);
    expect(sharedTaskInput.safeParse({ action: "batch", items: [{ action: "reopen", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }] }).success).toBe(true);
  });
});
