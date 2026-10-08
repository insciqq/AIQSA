import { describe, expect, it } from "vitest";
import {
  PERSONAL_USAGE_PURPOSES, RUN_USAGE_ATTRIBUTION_PURPOSES, SYSTEM_USAGE_PURPOSES, USAGE_PURPOSES,
  isPersonalUsagePurpose, isRunUsageAttributionPurpose, isUsagePurpose, memoryRoleUsagePurpose
} from "./usagePurpose";

describe("usage purpose", () => {
  it("splits every purpose into exactly one of personal and system", () => {
    expect(new Set(USAGE_PURPOSES).size).toBe(USAGE_PURPOSES.length);
    expect(USAGE_PURPOSES.filter(isPersonalUsagePurpose)).toEqual([...PERSONAL_USAGE_PURPOSES]);
    expect(USAGE_PURPOSES.filter((purpose) => !isPersonalUsagePurpose(purpose))).toEqual([...SYSTEM_USAGE_PURPOSES]);
    expect(isPersonalUsagePurpose("memory_processing")).toBe(false);
    // Dictation is the user's own request: it counts toward their budget, not a run's attributions.
    expect(isPersonalUsagePurpose("speech_to_text")).toBe(true);
    expect(isRunUsageAttributionPurpose("speech_to_text")).toBe(false);
    expect(isPersonalUsagePurpose("other")).toBe(false);
  });

  it("recognizes only the vocabulary", () => {
    expect(isUsagePurpose("knowledge_retrieval")).toBe(true);
    expect(isUsagePurpose("background")).toBe(false);
    expect(isUsagePurpose(null)).toBe(false);
  });

  it("limits a run's own attributions to its answer, Search and Knowledge query purposes", () => {
    expect(RUN_USAGE_ATTRIBUTION_PURPOSES.every(isUsagePurpose)).toBe(true);
    expect(RUN_USAGE_ATTRIBUTION_PURPOSES.filter(isRunUsageAttributionPurpose)).toEqual(["chat_answer", "web_search", "knowledge_retrieval"]);
    for (const purpose of ["image_generation", "chat_title", "chat_vision", "chat_pdf", "skill_selection", "memory_retrieval", undefined]) {
      expect(isRunUsageAttributionPurpose(purpose)).toBe(false);
    }
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
