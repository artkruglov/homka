/** Every wrapped application executor must recheck a scoped session before invoking tool code. */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defineTool, type ToolDefinition } from "eve/tools";
import { z } from "zod";
import { database, closeDatabase } from "../database.js";
import { sessionRepository } from "./session-repository.js";
import { wrapModelFacingTool } from "../model-facing-tool.js";
import { bindGroupToSpace } from "../spaces/two-space-fixture.js";

const dbDescribe = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;
let family: string, user: string, space: string, context: any;
function wrapped() {
  const execute = vi.fn(async () => ({ ok: true }));
  return { execute, tool: wrapModelFacingTool("space_probe", defineTool({ description: "Probe", inputSchema: z.object({}), execute }) as ToolDefinition<any, any>) };
}
dbDescribe("tool session space boundary", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE families,users CASCADE");
    family = (await database().query("INSERT INTO families(name) VALUES('Tool family') RETURNING id")).rows[0].id;
    user = (await database().query("INSERT INTO users(telegram_user_id,display_name) VALUES('space-tool-owner','Owner') RETURNING id")).rows[0].id;
    await database().query("INSERT INTO family_memberships(family_id,user_id,role) VALUES($1,$2,'owner')", [family,user]);
    space = (await database().query("INSERT INTO spaces(family_id,kind,title,owner_user_id) VALUES($1,'personal','Personal',$2) RETURNING id", [family,user])).rows[0].id;
    await database().query("INSERT INTO space_memberships(family_id,space_id,user_id,role,state) VALUES($1,$2,$3,'manager','active')", [family,space,user]);
    await database().query("UPDATE spaces SET state='active' WHERE id=$1", [space]);
    const session = await sessionRepository.prepareTurn({ familyId: family, userId: user, groupId: null, kind: "canonical", scope: "personal",
      baseContinuationToken: "space-tool-owner::", telegramForumTopicId: null, now: new Date(),
      spaceContext: { familyId: family, userId: user, spaceId: space, chat: { type: "private" } } });
    await sessionRepository.bindEveSession(session.id, "wrun_space_tool");
    context = { session: { id: "wrun_space_tool", auth: { current: { authenticator: "telegram", principalType: "user", principalId: user,
      attributes: { applicationSessionId: session.id, familyId: family, spaceId: space, spacePolicyVersion: String(session.spacePolicy!.policyVersion), telegramChatType: "private" } } } } };
  });
  afterAll(closeDatabase);
  it("executes for the current verified space", async () => {
    const probe = wrapped();
    await expect(probe.tool.execute({}, context)).resolves.toEqual({ ok: true });
    expect(probe.execute).toHaveBeenCalledOnce();
  });
  it("blocks an executor after membership revocation", async () => {
    await database().query("UPDATE space_memberships SET state='revoked' WHERE space_id=$1", [space]);
    const probe = wrapped();
    await expect(probe.tool.execute({}, context)).rejects.toBeDefined();
    expect(probe.execute).not.toHaveBeenCalled();
  });
  it("blocks a fabricated session policy version", async () => {
    context.session.auth.current.attributes.spacePolicyVersion = "999999";
    const probe = wrapped();
    await expect(probe.tool.execute({}, context)).rejects.toBeDefined();
    expect(probe.execute).not.toHaveBeenCalled();
  });
  it("blocks a partial scoped context instead of treating it as legacy", async () => {
    delete context.session.auth.current.attributes.spaceId;
    const probe = wrapped();
    await expect(probe.tool.execute({}, context)).rejects.toBeDefined();
    expect(probe.execute).not.toHaveBeenCalled();
  });
  it("blocks a retired application session even while membership remains active", async () => {
    await database().query("UPDATE conversation_sessions SET retired_at=now() WHERE id=$1", [context.session.auth.current.attributes.applicationSessionId]);
    const probe = wrapped();
    await expect(probe.tool.execute({}, context)).rejects.toBeDefined();
    expect(probe.execute).not.toHaveBeenCalled();
  });
  it("checks an external group's binding for an anonymous family outsider", async () => {
    const group = (await database().query("INSERT INTO telegram_groups(family_id,telegram_chat_id,title,type,message_mode) VALUES($1,'-tool-group','Group','external','addressed_only') RETURNING id", [family])).rows[0].id;
    const groupSpace = (await database().query("INSERT INTO spaces(family_id,kind,title,source_group_id) VALUES($1,'group','Group',$2) RETURNING id", [family,group])).rows[0].id;
    await database().query("UPDATE spaces SET state='active' WHERE id=$1", [groupSpace]);
    await bindGroupToSpace(database(), family,group,groupSpace);
    const session = await sessionRepository.prepareTurn({ familyId: family, userId: null, groupId: group, kind: "canonical", scope: "group",
      baseContinuationToken: "-tool-group::", telegramForumTopicId: null, now: new Date(),
      spaceContext: { familyId: family, userId: null, spaceId: groupSpace, chat: { type: "group", groupId: group } } });
    context.session.auth.current.principalId = "telegram:outsider";
    context.session.auth.current.attributes = { familyId: family, groupId: group, applicationSessionId: session.id,
      spaceId: groupSpace, spacePolicyVersion: String(session.spacePolicy!.policyVersion), telegramChatType: "group" };
    const probe = wrapped();
    await expect(probe.tool.execute({}, context)).resolves.toEqual({ ok: true });
    await database().query("UPDATE space_bindings SET state='paused' WHERE group_id=$1", [group]);
    await expect(probe.tool.execute({}, context)).rejects.toBeDefined();
    expect(probe.execute).toHaveBeenCalledOnce();
  });
  it("blocks another principal even in the same family", async () => {
    context.session.auth.current.principalId = crypto.randomUUID();
    const probe = wrapped();
    await expect(probe.tool.execute({}, context)).rejects.toBeDefined();
    expect(probe.execute).not.toHaveBeenCalled();
  });
});
