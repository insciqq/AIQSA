import { describe, expect, it } from "vitest";
import {
  memoryEntityAliases,
  memoryEntityCanonicalKey,
  normalizeMemoryEntityAlias
} from "./normalization";
import {
  resolveMemoryEntityCandidate,
  resolveMemoryEntityRoot
} from "./resolver";

describe("Memory entity normalization and resolution", () => {
  it("normalizes exact aliases without transliteration or language word lists", () => {
    expect(normalizeMemoryEntityAlias(" «MacBook Air» ")).toBe("macbook air");
    expect(normalizeMemoryEntityAlias("МАКБУК")).toBe("макбук");
    expect(normalizeMemoryEntityAlias("макбук")).not.toBe("macbook");
    expect(normalizeMemoryEntityAlias("его")).toBe("его");
    expect(memoryEntityAliases({
      aliases: ["it"],
      canonicalLabel: "device",
      mention: "it",
      mentionKind: "PRONOMINAL"
    })).toEqual([]);
  });

  it("keeps broad and specific product keys distinct", () => {
    expect(memoryEntityCanonicalKey({
      canonicalLabel: "MacBook",
      entityType: "PRODUCT"
    })).not.toBe(memoryEntityCanonicalKey({
      canonicalLabel: "MacBook Air M4",
      entityType: "PRODUCT",
      qualifiers: { brand: "Apple", model: "MacBook Air M4" }
    }));
  });

  it("uses context, canonical key, then one unambiguous supported alias", () => {
    const canonicalKey = memoryEntityCanonicalKey({
      canonicalLabel: "MacBook Air M4",
      entityType: "PRODUCT",
      qualifiers: { brand: "Apple", model: "MacBook Air M4" }
    })!;
    const candidate = {
      aliases: ["macbook air", "макбук"],
      canonicalKey,
      entityType: "PRODUCT" as const,
      id: "entity-1",
      rootId: "entity-1"
    };
    expect(resolveMemoryEntityCandidate({
      aliases: ["макбук"],
      canonicalLabel: "MacBook Air M4",
      contextEntityId: null,
      entityType: "PRODUCT",
      qualifiers: { brand: "Apple", model: "MacBook Air M4" }
    }, [candidate])).toMatchObject({ entityId: "entity-1", outcome: "REUSE" });
    expect(resolveMemoryEntityCandidate({
      aliases: ["макбук"],
      canonicalLabel: "MacBook Air M4",
      contextEntityId: null,
      entityType: "PRODUCT",
      qualifiers: { brand: "Apple", model: "MacBook Air M4" }
    }, [candidate, { ...candidate, canonicalKey: "other", id: "entity-2", rootId: "entity-2" }]))
      .toMatchObject({ entityId: "entity-1", outcome: "REUSE" });
  });

  it("rejects ambiguous aliases and merge cycles", () => {
    const common = {
      aliases: ["alex"],
      entityType: "PERSON" as const
    };
    expect(resolveMemoryEntityCandidate({
      aliases: ["Alex"],
      canonicalLabel: "Alex",
      contextEntityId: null,
      entityType: "PERSON",
      qualifiers: {}
    }, [
      { ...common, canonicalKey: "person:a", id: "a", rootId: "a" },
      { ...common, canonicalKey: "person:b", id: "b", rootId: "b" }
    ])).toMatchObject({ outcome: "AMBIGUOUS" });
    expect(() => resolveMemoryEntityRoot("a", new Map([
      ["a", "b"],
      ["b", "a"]
    ]))).toThrow("memory_entity_merge_cycle");
  });
});
