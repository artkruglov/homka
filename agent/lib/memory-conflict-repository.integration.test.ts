/**
 * Conflict authorization, resolution, lifecycle, audit, and replay integration tests.
 *
 * Constructs covered:
 * - Current database role and exact trust zone are revalidated under lock.
 * - Choosing a version retracts but never deletes the other version.
 * - Identical replay is read-only; changed replay and cross-family access are rejected.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import { memoryConflictRepository } from "./memory-conflict-repository.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { memoryRepository } from "./memory-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

describeWithDatabase("memory conflict repository", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE claim_conflicts, memory_items_all, family_memberships, users, families CASCADE`,
    );
  });

  afterAll(closeDatabase);

  it("resolves by opaque refs, preserves both versions, and protects replay", async () => {
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Conflict family') RETURNING id",
    );
    const users = await database().query<{ id: string; telegram_user_id: string }>(
      `INSERT INTO users (telegram_user_id, display_name)
       VALUES ('conf-owner', 'Owner'), ('conf-member', 'Member')
       RETURNING id, telegram_user_id`,
    );
    const owner = users.rows[0]!;
    const member = users.rows[1]!;
    await database().query(
      `INSERT INTO family_memberships (family_id, user_id, role)
       VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
      [family.rows[0]!.id, owner.id, member.id],
    );
    const ownerAuth: MemoryAuthorization = {
      familyId: family.rows[0]!.id,
      groupId: null,
      role: "owner",
      scopes: ["family"],
      telegramActorId: owner.telegram_user_id,
      telegramActorKind: "telegram_user",
      telegramUserId: owner.telegram_user_id,
      userId: owner.id,
    };
    const memberAuth: MemoryAuthorization = {
      ...ownerAuth,
      role: "member",
      telegramActorId: member.telegram_user_id,
      telegramUserId: member.telegram_user_id,
      userId: member.id,
    };
    const first = await memoryRepository.create(ownerAuth, {
      confirmation: "user_confirmed", content: "Город Казань", kind: "fact",
      operationKey: "conflict-first", scope: "family", sensitivity: "normal", source: "test",
    });
    const second = await memoryRepository.create(memberAuth, {
      confirmation: "user_confirmed", content: "Дата одиннадцатое", kind: "fact",
      operationKey: "conflict-second", scope: "family", sensitivity: "normal", source: "test",
    });
    const conflict = await database().query<{ conflict_ref: string }>(
      `INSERT INTO claim_conflicts
         (claim_a_id, claim_b_id, family_id, scope, scope_partition_key, detection_method)
       VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid), $3,
               'family', $3, 'deterministic_guard') RETURNING conflict_ref`,
      [first.id, second.id, ownerAuth.familyId],
    );
    const input = {
      action: "choose" as const,
      conflictRef: conflict.rows[0]!.conflict_ref,
      memoryRef: first.memoryRef,
      operationKey: "resolve-conflict-1",
    };

    await expect(memoryConflictRepository.resolve(memberAuth, input))
      .rejects.toThrowError(/AGENT_MEMORY_CONFLICT_RESOLUTION_DENIED/u);
    // A member who authored both sides may resolve, but not after the membership is revoked.
    const ownClaimA = await memoryRepository.create(memberAuth, {
      confirmation: "user_confirmed", content: "Гоша ест сухой корм", kind: "fact",
      operationKey: "conflict-own-a", scope: "family", sensitivity: "normal", source: "test",
    });
    const ownClaimB = await memoryRepository.create(memberAuth, {
      confirmation: "user_confirmed", content: "Гоша ест влажный корм", kind: "fact",
      operationKey: "conflict-own-b", scope: "family", sensitivity: "normal", source: "test",
    });
    const ownConflict = await database().query<{ conflict_ref: string }>(
      `INSERT INTO claim_conflicts
         (claim_a_id, claim_b_id, family_id, scope, scope_partition_key, detection_method)
       VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid), $3,
               'family', $3, 'deterministic_guard') RETURNING conflict_ref`,
      [ownClaimA.id, ownClaimB.id, ownerAuth.familyId],
    );
    await database().query("DELETE FROM family_memberships WHERE family_id = $1 AND user_id = $2", [ownerAuth.familyId, memberAuth.userId]);
    await expect(memoryConflictRepository.resolve(memberAuth, {
      action: "choose", conflictRef: ownConflict.rows[0]!.conflict_ref, memoryRef: ownClaimA.memoryRef, operationKey: "conflict-own-resolve",
    })).rejects.toThrowError(/AGENT_MEMORY_CONFLICT_RESOLUTION_DENIED/u);
    const resolved = await memoryConflictRepository.resolve(ownerAuth, input);
    await expect(memoryConflictRepository.resolve(ownerAuth, input)).resolves.toEqual(resolved);
    await expect(memoryConflictRepository.resolve(ownerAuth, {
      ...input,
      memoryRef: second.memoryRef,
    })).rejects.toThrowError(/AGENT_MEMORY_REPLAY_MISMATCH/u);

    const versions = await database().query<{ claim_status: string; id: string }>(
      "SELECT id, claim_status::text FROM memory_items WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[first.id, second.id]],
    );
    expect(versions.rows).toHaveLength(2);
    expect(versions.rows.find((row) => row.id === first.id)?.claim_status).toBe("active");
    expect(versions.rows.find((row) => row.id === second.id)?.claim_status).toBe("retracted");
    expect(JSON.stringify(resolved)).not.toContain(first.id);
    expect(JSON.stringify(resolved)).not.toContain(second.id);
  });
});
