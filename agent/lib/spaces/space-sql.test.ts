/**
 * Позиции параметров это авторский SQL; подставить туда произвольный текст нельзя.
 *
 * Поведение самой оговорки проверяется исполнением в `space-sql.integration.test.ts`: сверка
 * подстрок сгенерированного SQL пропустила бы вывернутый наизнанку предикат.
 */
import { describe, expect, it } from "vitest";

import { spaceReadClause } from "./space-sql.js";

const parameters = { family: "$1", group: "$4", spaceId: "$9", user: "$3", version: "$10" };

describe("spaceReadClause", () => {
  it("places every position the caller chose", () => {
    const clause = spaceReadClause({ alias: "item", parameters });
    expect(clause).toContain("item.space_id = $9::uuid");
    expect(clause).toContain("live_space.policy_version=$10::integer");
    expect(clause).toContain("live_space.family_id=$1");
    expect(clause).toContain("live_space_member.user_id=$3");
    expect(clause).toContain("live_binding.group_id=$4");
  });

  it("lets a caller free of the memory numbering use its own positions", () => {
    const clause = spaceReadClause({
      alias: "task",
      parameters: { family: "$2", group: "$5", spaceId: "$1", user: "$3", version: "$4" },
    });
    expect(clause).toContain("task.space_id = $1::uuid");
    expect(clause).toContain("live_space.policy_version=$4::integer");
  });

  for (const invalid of ["$1; DROP TABLE spaces", "family_id", "$", "$1234"]) {
    it(`refuses ${JSON.stringify(invalid)} as a parameter position`, () => {
      expect(() => spaceReadClause({ alias: "item", parameters: { ...parameters, family: invalid } }))
        .toThrow(/AGENT_SPACE_SQL_PARAMETER_INVALID/u);
    });
  }

  it("refuses an alias that is not a plain identifier", () => {
    expect(() => spaceReadClause({ alias: 'item"; DROP TABLE spaces; --', parameters }))
      .toThrow(/AGENT_SPACE_SQL_ALIAS_INVALID/u);
  });
});
