/**
 * Turn timezone PostgreSQL integration tests.
 *
 * Constructs covered:
 * - A member with a timezone setting speaks in their own timezone.
 * - A member without a setting and a non-member (null user) inherit the family owner's timezone.
 * - A family whose owner has no setting resolves to null; another family's settings never leak.
 */
import { afterAll, describe, expect, it } from "vitest";

import { currentTimeRepository } from "./current-time-repository.js";
import { closeDatabase, database } from "./database.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled) {
  if (!url) throw new Error("AGENT_TEST_DATABASE_CONFIG_MISSING: Для integration-тестов не задан DATABASE_URL");
  if (!new URL(url).pathname.slice(1).endsWith("_test")) {
    throw new Error("AGENT_TEST_DATABASE_UNSAFE: Integration-тесты разрешены только для БД с суффиксом _test");
  }
}
const describeWithDatabase = enabled ? describe : describe.skip;

interface Fixture {
  familyId: string;
  memberWithTimezoneId: string;
  memberWithoutTimezoneId: string;
  otherFamilyId: string;
  otherOwnerId: string;
  ownerId: string;
}

async function createFixture(suffix: string, ownerTimezone: string | null): Promise<Fixture> {
  const families = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ($1), ($2) RETURNING id",
    [`Turn timezone family ${suffix}`, `Turn timezone other family ${suffix}`],
  );
  const familyId = families.rows[0]!.id;
  const otherFamilyId = families.rows[1]!.id;
  const users = await database().query<{ id: string }>(
    `INSERT INTO users (telegram_user_id, display_name)
     VALUES ($1, 'Владелец'), ($2, 'Участник с поясом'), ($3, 'Участник без пояса'), ($4, 'Чужой владелец')
     RETURNING id`,
    [`tz-owner-${suffix}`, `tz-member-${suffix}`, `tz-plain-${suffix}`, `tz-other-${suffix}`],
  );
  const [ownerId, memberWithTimezoneId, memberWithoutTimezoneId, otherOwnerId] = users.rows.map((row) => row.id) as [
    string,
    string,
    string,
    string,
  ];
  await database().query(
    `INSERT INTO family_memberships (family_id, user_id, role)
     VALUES ($1, $2, 'owner'), ($1, $3, 'member'), ($1, $4, 'member'), ($5, $6, 'owner')`,
    [familyId, ownerId, memberWithTimezoneId, memberWithoutTimezoneId, otherFamilyId, otherOwnerId],
  );
  await database().query(
    "INSERT INTO user_notification_settings (user_id, timezone) VALUES ($1, 'Asia/Tokyo'), ($2, 'America/New_York')",
    [memberWithTimezoneId, otherOwnerId],
  );
  if (ownerTimezone !== null) {
    await database().query(
      "INSERT INTO user_notification_settings (user_id, timezone) VALUES ($1, $2)",
      [ownerId, ownerTimezone],
    );
  }
  return { familyId, memberWithTimezoneId, memberWithoutTimezoneId, otherFamilyId, otherOwnerId, ownerId };
}

describeWithDatabase("currentTimeRepository.findTurnTimezone", () => {
  afterAll(async () => {
    await closeDatabase();
  });

  it("prefers the member's own timezone and falls back to the owner's", async () => {
    const fixture = await createFixture(`own-${Date.now()}`, "Europe/Moscow");

    await expect(currentTimeRepository.findTurnTimezone(fixture.memberWithTimezoneId, fixture.familyId))
      .resolves.toBe("Asia/Tokyo");
    await expect(currentTimeRepository.findTurnTimezone(fixture.memberWithoutTimezoneId, fixture.familyId))
      .resolves.toBe("Europe/Moscow");
    await expect(currentTimeRepository.findTurnTimezone(null, fixture.familyId))
      .resolves.toBe("Europe/Moscow");
    await expect(currentTimeRepository.findTurnTimezone(fixture.ownerId, fixture.familyId))
      .resolves.toBe("Europe/Moscow");
  });

  it("resolves to null without an owner setting and never reads another family", async () => {
    const fixture = await createFixture(`none-${Date.now()}`, null);

    await expect(currentTimeRepository.findTurnTimezone(null, fixture.familyId)).resolves.toBeNull();
    await expect(currentTimeRepository.findTurnTimezone(fixture.memberWithoutTimezoneId, fixture.familyId))
      .resolves.toBeNull();
    await expect(currentTimeRepository.findTurnTimezone(fixture.memberWithTimezoneId, fixture.familyId))
      .resolves.toBe("Asia/Tokyo");
    // A user id from another family gets that family's owner, not the stranger's own setting.
    await expect(currentTimeRepository.findTurnTimezone(fixture.otherOwnerId, fixture.familyId))
      .resolves.toBeNull();
  });
});
