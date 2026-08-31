import { describe, expect, it } from "vitest";
import {
  assertMemoryLexicalSearchRequest,
  assertMemoryLexicalSearchResult,
  hasAcceptedCompleteMemoryLexicalVariant,
  type MemoryLexicalSearchRequest,
  type MemoryLexicalSearchResult
} from "./contract";

function request(
  overrides: Partial<MemoryLexicalSearchRequest> = {}
): MemoryLexicalSearchRequest {
  return {
    activeGenerationId: "generation-1",
    analysisProfileVersion: "UNICODE_ICU_NGRAM_V1",
    candidateLimitPerVariant: 24,
    deadlineAtMs: Date.now() + 1_000,
    finalLimit: 12,
    itemFamily: "HISTORY",
    memoryRevisionSnapshot: 7,
    sourceChatIds: ["source-chat-1"],
    userId: "user-1",
    variants: [{
      logicalTerms: [{ characterLength: 5, ordinal: 0, value: "cedar" }],
      normalizedText: "cedar project",
      ordinal: 0
    }],
    ...overrides
  };
}

function result(
  input: MemoryLexicalSearchRequest
): MemoryLexicalSearchResult {
  return {
    candidates: [{
      backendScore: 0.75,
      matchedTermCount: 1,
      matchMode: "UNICODE",
      maximumMatchedTermLength: 5,
      rankWithinVariant: 1,
      safeContentHash: "a".repeat(64),
      searchEntryId: "entry-1",
      variantOrdinal: 0
    }],
    evidence: {
      backend: "POSTGRES",
      durationMs: 4,
      failureCode: null,
      fallbackUsed: false,
      lane: "HISTORY_RECALL_LEXICAL_UNICODE",
      matchMode: "UNICODE",
      opaqueId: null,
      projectionCaughtUp: true,
      projectionEventLag: null,
      projectionRevisionLag: null,
      projectionVisibleAgeMs: null,
      rawCandidateCount: 1,
      requestedLimit: input.finalLimit,
      timedOut: false
    }
  };
}

describe("Memory lexical provider contract", () => {
  it("accepts only bounded language-neutral query variants and opaque authority scope", () => {
    const input = request();

    expect(() => assertMemoryLexicalSearchRequest(input)).not.toThrow();
    expect(JSON.stringify(input)).not.toMatch(
      /englishTerms|russianTerms|hasLatin|hasCyrillic/u
    );
    expect(() => assertMemoryLexicalSearchRequest(request({
      itemFamily: "FACT",
      sourceChatIds: ["source-chat-1"]
    }))).toThrow("memory_lexical_search_request_invalid");
    expect(() => assertMemoryLexicalSearchRequest(request({
      candidateLimitPerVariant: 501
    }))).toThrow("memory_lexical_search_request_invalid");
    expect(() => assertMemoryLexicalSearchRequest(request({
      variants: [{
        logicalTerms: [{ characterLength: 4, ordinal: 0, value: "cedar" }],
        normalizedText: "cedar",
        ordinal: 0
      }]
    }))).toThrow("memory_lexical_search_request_invalid");
  });

  it("rejects unbounded, duplicate, or content-hash-free provider results", () => {
    const input = request();
    const valid = result(input);

    expect(() => assertMemoryLexicalSearchResult(input, valid, "POSTGRES"))
      .not.toThrow();
    expect(() => assertMemoryLexicalSearchResult(input, {
      ...valid,
      candidates: [{ ...valid.candidates[0]!, safeContentHash: "not-a-hash" }]
    }, "POSTGRES")).toThrow("memory_lexical_search_result_invalid");
    expect(() => assertMemoryLexicalSearchResult(input, {
      ...valid,
      candidates: [valid.candidates[0]!, valid.candidates[0]!],
      evidence: { ...valid.evidence, rawCandidateCount: 2 }
    }, "POSTGRES")).toThrow("memory_lexical_search_result_invalid");
    expect(() => assertMemoryLexicalSearchResult(input, valid, "OPENSEARCH"))
      .toThrow("memory_lexical_search_result_invalid");
  });

  it("suppresses fallback only for a complete canonically accepted variant", () => {
    const input = request({
      variants: [{
        logicalTerms: [
          { characterLength: 9, ordinal: 0, value: "Aleksandar" },
          { characterLength: 7, ordinal: 1, value: "Beograd" }
        ],
        normalizedText: "Aleksandar Beograd",
        ordinal: 0
      }]
    });
    const partial = {
      ...result(input).candidates[0]!,
      matchedTermCount: 1
    };
    const complete = {
      ...partial,
      matchedTermCount: 2,
      searchEntryId: "entry-2"
    };

    expect(hasAcceptedCompleteMemoryLexicalVariant({
      acceptedSearchEntryIds: ["entry-1"],
      candidates: [partial, complete],
      request: input
    })).toBe(false);
    expect(hasAcceptedCompleteMemoryLexicalVariant({
      acceptedSearchEntryIds: ["entry-2"],
      candidates: [partial, complete],
      request: input
    })).toBe(true);
    expect(hasAcceptedCompleteMemoryLexicalVariant({
      acceptedSearchEntryIds: [],
      candidates: [complete],
      request: input
    })).toBe(false);
  });
});
