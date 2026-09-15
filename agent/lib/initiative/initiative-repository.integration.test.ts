/**
 * Журнал начатых ботом разговоров.
 *
 * Проверяется: предел считается сутками человека, а не сервера; его слово снимает паузу целиком;
 * человек без настроек живёт по умолчанию, а не остаётся без правила.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { decideInitiative } from "./initiative-policy.js";
import { initiativeRepository } from "./initiative-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

let familyId = "";
let userId = "";

describeWithDatabase("initiative journal", () => {
  beforeEach(async () => {
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Инициатива') RETURNING id",
    );
    familyId = family.rows[0]!.id;
    const user = await database().query<{ id: string }>(
      `INSERT INTO users (telegram_user_id, display_name)
       VALUES ($1, 'Владелец') RETURNING id`,
      [`initiative-${Date.now()}-${Math.random().toString(36).slice(2)}`],
    );
    userId = user.rows[0]!.id;
    await database().query(
      "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
      [familyId, userId],
    );
  });

  afterAll(async () => { await closeDatabase(); });

  it("gives a person without settings the default rule instead of no rule", async () => {
    const current = await initiativeRepository.read(userId, new Date("2026-09-12T09:00:00.000Z"));
    expect(current).toMatchObject({
      settings: { dailyLimit: 3, enabled: true, quietEnd: null, quietStart: null, timezone: "UTC" },
      state: { sentToday: 0, unanswered: 0 },
    });
  });

  it("counts the day in the timezone of the person, not of the server", async () => {
    await database().query(
      `INSERT INTO user_notification_settings (user_id, timezone, quiet_start, quiet_end)
       VALUES ($1, 'Asia/Vladivostok', NULL, NULL)`,
      [userId],
    );
    // Утро 13 сентября во Владивостоке это ещё 12-е по UTC: сервер насчитал бы вчерашний день.
    const sent = new Date("2026-09-12T22:00:00.000Z");
    await initiativeRepository.record({ familyId, kind: "suggestion", now: sent, userId });
    await expect(initiativeRepository.read(userId, sent))
      .resolves.toMatchObject({ state: { sentToday: 1 } });
    await expect(initiativeRepository.read(userId, new Date("2026-09-12T13:00:00.000Z")))
      .resolves.toMatchObject({ state: { sentToday: 0 } });
  });

  it("stops after three unanswered and starts again once the person speaks", async () => {
    const now = new Date("2026-09-12T09:00:00.000Z");
    for (let index = 0; index < 3; index += 1) {
      await initiativeRepository.record({
        familyId, kind: "suggestion", now: new Date(now.getTime() - index * 86_400_000), userId,
      });
    }
    const held = (await initiativeRepository.read(userId, now))!;
    expect(held.state.unanswered).toBe(3);
    expect(decideInitiative(held.settings, held.state, now))
      .toEqual({ allowed: false, reason: "unanswered" });

    await initiativeRepository.markAnswered(userId, now);
    const answered = (await initiativeRepository.read(userId, now))!;
    expect(answered.state.unanswered).toBe(0);
    expect(decideInitiative(answered.settings, answered.state, now)).toEqual({ allowed: true });
  });
});
