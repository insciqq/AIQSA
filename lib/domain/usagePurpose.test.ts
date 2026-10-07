import { describe, expect, it } from "vitest";
import {
  PERSONAL_USAGE_PURPOSES, SYSTEM_USAGE_PURPOSES, USAGE_PURPOSES,
  isPersonalUsagePurpose, isUsagePurpose, memoryRoleUsagePurpose
} from "./usagePurpose";

describe("usage purpose", () => {
  it("splits every purpose into exactly one of personal and system", () => {
    expect(new Set(USAGE_PURPOSES).size).toBe(USAGE_PURPOSES.length);
    expect(USAGE_PURPOSES.filter(isPersonalUsagePurpose)).toEqual([...PERSONAL_USAGE_PURPOSES]);
    expect(USAGE_PURPOSES.filter((purpose) => !isPersonalUsagePurpose(purpose))).toEqual([...SYSTEM_USAGE_PURPOSES]);
    expect(isPersonalUsagePurpose("memory_processing")).toBe(false);
    expect(isPersonalUsagePurpose("other")).toBe(false);
  });

  it("recognizes only the vocabulary", () => {
    expect(isUsagePurpose("knowledge_retrieval")).toBe(true);
    expect(isUsagePurpose("background")).toBe(false);
    expect(isUsagePurpose(null)).toBe(false);
  });

  it("maps Memory roles to indexing, retrieval or processing", () => {
    expect(memoryRoleUsagePurpose("MEMORY_DOCUMENT_EMBED")).toBe("memory_indexing");
    for (const role of ["MEMORY_QUERY_EMBED", "MEMORY_RERANK", "MEMORY_HISTORY_RELEVANCE", "MEMORY_QUERY_RESOLVE"]) {
      expect(memoryRoleUsagePurpose(role)).toBe("memory_retrieval");
    }
    for (const role of ["MEMORY_FACT_EXTRACT", "MEMORY_CONSOLIDATE", "MEMORY_CONTROL", "MEMORY_SYNTHESIZE", "MEMORY_VERIFY"]) {
      expect(memoryRoleUsagePurpose(role)).toBe("memory_processing");
    }
  });
});
