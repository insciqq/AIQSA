import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import type { MemoryTransaction } from "../../persistence/transaction";
import { loadMemoryFactContextRefs } from "./context";

function fakeTransaction() {
  const aliasLookups: unknown[][] = [];
  const tx = {
    async $queryRaw(query: Prisma.Sql) {
      const text = query.text;
      if (text.includes("WITH eligible AS")) {
        return [
          { displayText: "Works at Example", factVersionId: "version-1", identitySubjectKey: null },
          { displayText: "Lives in Riga", factVersionId: "version-2", identitySubjectKey: null },
          { displayText: "Owns a bike", factVersionId: "version-3", identitySubjectKey: null }
        ];
      }
      if (text.includes(`FROM "MemoryFactVersionEntity" AS link`)) {
        const other = query.values.includes("version-3");
        return [{ canonicalId: other ? "entity-b" : "entity-a", displayName: other ? "Bike" : "Ann",
          entityType: other ? "THING" : "PERSON", role: "SUBJECT" }];
      }
      if (text.includes(`FROM "MemoryEntityAlias" AS alias`)) {
        aliasLookups.push(query.values);
        const entity = query.values.includes("entity-b") ? "entity-b" : "entity-a";
        return [{ displayAlias: entity === "entity-b" ? "Bike" : "Ann", entityId: entity, id: `alias-${entity}`,
          normalizedAlias: entity === "entity-b" ? "bike" : "ann" }];
      }
      throw new Error("unexpected query");
    }
  };
  return { aliasLookups, tx: tx as unknown as MemoryTransaction };
}

describe("loadMemoryFactContextRefs", () => {
  it("loads each entity's admissible aliases once for all facts about it", async () => {
    const { aliasLookups, tx } = fakeTransaction();
    const refs = await loadMemoryFactContextRefs(tx, { messages: [], userId: "user-1" });
    expect(refs.map(({ aliases, entityId }) => ({ aliases, entityId }))).toEqual([
      { aliases: ["Ann"], entityId: "entity-a" },
      { aliases: ["Ann"], entityId: "entity-a" },
      { aliases: ["Bike"], entityId: "entity-b" }
    ]);
    expect(aliasLookups).toHaveLength(2);
  });
});
