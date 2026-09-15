/** Новая связанная с областью таблица обязана объявить, чем у неё держится граница. */
import { describe, expect, it } from "vitest";

import { legacyAuditCatalog } from "./legacy-space-audit-catalog.js";
import { SPACE_ENFORCEMENT_EXCEPTIONS, spaceEnforcementFor } from "./space-enforcement-catalog.js";

describe("space enforcement catalog", () => {
  it("gives every migrated relation a way its boundary is held", () => {
    const mapped = Object.keys(legacyAuditCatalog).filter((table) => legacyAuditCatalog[table]!.action === "map");
    expect(mapped.length).toBeGreaterThan(50);
    expect(mapped.filter((table) => spaceEnforcementFor(table) === null)).toEqual([]);
  });

  it("leaves relations outside the migration without a space obligation", () => {
    expect(spaceEnforcementFor("families")).toBeNull();
    expect(spaceEnforcementFor("schema_migrations")).toBeNull();
    expect(spaceEnforcementFor("family_space_runtime")).toBeNull();
  });

  it("derives the obligation from the relation's own boundary", () => {
    // Своя граница у записи памяти, унаследованная — у её ссылки.
    expect(spaceEnforcementFor("memory_items_all")).toBe("sql_space_clause");
    expect(spaceEnforcementFor("memory_item_refs")).toBe("parent_inherited");
  });

  it("names a reason for every exception and never invents a relation", () => {
    for (const [table, exception] of Object.entries(SPACE_ENFORCEMENT_EXCEPTIONS)) {
      expect(legacyAuditCatalog[table], table).toBeDefined();
      expect(exception.reason.length, table).toBeGreaterThan(20);
    }
  });
});
