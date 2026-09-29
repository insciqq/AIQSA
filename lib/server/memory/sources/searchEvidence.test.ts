import { describe, expect, it } from "vitest";
import { decodeMemorySearchSourceEvidence } from "./searchEvidence";

const fact = {
  exactItemId: "version-1", factVersionId: "version-1", featureSnapshot: {},
  includedText: "I prefer concise answers.", itemType: "FACT_VERSION",
  recallChunkId: null, recallRoundId: null, selectionReason: "search",
  sourceBranchGenerationSnapshot: null, sourceChatId: null,
  sourceContentHashSnapshot: null, sourceMessageIds: [], sourceRevisionSnapshot: null
};

describe("native Memory search source receipts", () => {
  it("accepts only the new exact bounded evidence contract", () => {
    expect(decodeMemorySearchSourceEvidence({ version: "memory-search-v1", results: [fact] }))
      .toEqual([fact]);
    for (const results of [
      { results: [fact] },
      { version: "memory-search-v0", results: [fact] },
      { version: "memory-search-v1", results: Array.from({ length: 31 }, () => fact) },
      { version: "memory-search-v1", results: [{ ...fact, factVersionId: "other" }] },
      { version: "memory-search-v1", results: [{ ...fact, recallChunkId: "unexpected" }] },
      { version: "memory-search-v1", results: [{ ...fact, sourceMessageIds: [null] }] },
      { version: "memory-search-v1", results: [{ ...fact, sourceRevisionSnapshot: -1 }] }
    ]) expect(decodeMemorySearchSourceEvidence(results)).toEqual([]);
  });
});
