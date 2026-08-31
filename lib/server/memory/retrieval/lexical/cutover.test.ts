import { describe, expect, it } from "vitest";
import type {
  MemoryLexicalCandidateProvider,
  MemoryLexicalFailureCode,
  MemoryLexicalSearchRequest,
  MemoryLexicalSearchResult
} from "./contract";
import {
  MemoryLexicalCircuitBreaker,
  RoutedMemoryLexicalCandidateProvider,
  memoryLexicalCanaryBucket,
  memoryLexicalOpenSearchSelected
} from "./cutover";

function request(userId = "user-1"): MemoryLexicalSearchRequest {
  return {
    activeGenerationId: "generation-1",
    analysisProfileVersion: "UNICODE_ICU_NGRAM_V1",
    candidateLimitPerVariant: 24,
    deadlineAtMs: Date.now() + 5_000,
    finalLimit: 12,
    itemFamily: "FACT",
    memoryRevisionSnapshot: 7,
    userId,
    variants: [{
      logicalTerms: [{ characterLength: 5, ordinal: 0, value: "cedar" }],
      normalizedText: "cedar",
      ordinal: 0
    }]
  };
}

function result(
  backend: "OPENSEARCH" | "POSTGRES",
  failureCode: MemoryLexicalFailureCode | null = null
): MemoryLexicalSearchResult {
  const failed = failureCode !== null;
  const candidates = failed ? [] : [{
    backendScore: 0.75,
    matchedTermCount: 1,
    matchMode: "UNICODE" as const,
    maximumMatchedTermLength: 5,
    rankWithinVariant: 1,
    safeContentHash: "a".repeat(64),
    searchEntryId: `${backend.toLowerCase()}-entry-1`,
    variantOrdinal: 0
  }];
  return {
    candidates,
    evidence: {
      backend,
      durationMs: 4,
      failureCode,
      fallbackUsed: false,
      lane: "FACT_LEXICAL_UNICODE",
      matchMode: failed ? null : "UNICODE",
      opaqueId: backend === "OPENSEARCH" ? "opaque-request-1" : null,
      projectionCaughtUp: backend === "OPENSEARCH" ? !failed : true,
      projectionEventLag: backend === "OPENSEARCH" ? Number(failed) : null,
      projectionRevisionLag: backend === "OPENSEARCH" ? Number(failed) : null,
      projectionVisibleAgeMs: backend === "OPENSEARCH" ? 10 : null,
      rawCandidateCount: candidates.length,
      requestedLimit: 12,
      timedOut: failureCode === "memory_opensearch_timeout"
    }
  };
}

function provider(
  backend: "OPENSEARCH" | "POSTGRES",
  search: (input: MemoryLexicalSearchRequest) => Promise<MemoryLexicalSearchResult>
): MemoryLexicalCandidateProvider {
  return { backend, search };
}

describe("Memory lexical OpenSearch cutover", () => {
  it("uses a stable opaque user bucket with exact percentage boundaries", () => {
    const scope = "f".repeat(64);
    const bucket = memoryLexicalCanaryBucket(scope);
    expect(bucket).toBeGreaterThanOrEqual(0);
    expect(bucket).toBeLessThan(100);
    expect(memoryLexicalCanaryBucket(scope)).toBe(bucket);
    expect(memoryLexicalOpenSearchSelected(
      { backend: "OPENSEARCH_CANARY", canaryPercent: bucket + 1 },
      scope
    )).toBe(true);
    if (bucket > 0) {
      expect(memoryLexicalOpenSearchSelected(
        { backend: "OPENSEARCH_CANARY", canaryPercent: bucket },
        scope
      )).toBe(false);
    }
    expect(memoryLexicalOpenSearchSelected(
      { backend: "OPENSEARCH", canaryPercent: 1 },
      scope
    )).toBe(true);
    expect(memoryLexicalOpenSearchSelected(
      { backend: "POSTGRES", canaryPercent: 100 },
      scope
    )).toBe(false);
    expect(() => memoryLexicalCanaryBucket("private-user-id"))
      .toThrow("memory_lexical_canary_scope_invalid");
  });

  it("opens after bounded consecutive failures and admits one half-open probe", () => {
    let now = 1_000;
    const breaker = new MemoryLexicalCircuitBreaker({
      cooldownMs: 2_000,
      failureThreshold: 2
    }, () => now);

    const first = breaker.acquire();
    expect(first).not.toBeNull();
    breaker.failure(first!);
    expect(breaker.snapshot()).toMatchObject({
      consecutiveFailureCount: 1,
      state: "CLOSED"
    });
    const second = breaker.acquire();
    breaker.failure(second!);
    expect(breaker.snapshot()).toMatchObject({
      consecutiveFailureCount: 2,
      state: "OPEN"
    });
    expect(breaker.acquire()).toBeNull();

    now += 2_000;
    const probe = breaker.acquire();
    expect(probe?.kind).toBe("HALF_OPEN");
    expect(breaker.acquire()).toBeNull();
    breaker.failure(probe!);
    expect(breaker.snapshot().state).toBe("OPEN");

    now += 2_000;
    const recovery = breaker.acquire();
    expect(recovery?.kind).toBe("HALF_OPEN");
    breaker.success(recovery!);
    expect(breaker.snapshot()).toEqual({
      consecutiveFailureCount: 0,
      state: "CLOSED"
    });
  });

  it("keeps independent Memory breaker instances isolated", () => {
    const first = new MemoryLexicalCircuitBreaker({
      cooldownMs: 1_000,
      failureThreshold: 1
    });
    const second = new MemoryLexicalCircuitBreaker({
      cooldownMs: 1_000,
      failureThreshold: 1
    });
    first.failure(first.acquire()!);
    expect(first.snapshot().state).toBe("OPEN");
    expect(second.snapshot().state).toBe("CLOSED");
  });

  it("uses OpenSearch for a selected user and PostgreSQL for a non-canary user", async () => {
    let openSearchCalls = 0;
    let postgresCalls = 0;
    const openSearch = provider("OPENSEARCH", async () => {
      openSearchCalls += 1;
      return result("OPENSEARCH");
    });
    const postgres = provider("POSTGRES", async () => {
      postgresCalls += 1;
      return result("POSTGRES");
    });
    const breaker = new MemoryLexicalCircuitBreaker({
      cooldownMs: 1_000,
      failureThreshold: 2
    });
    const selected = new RoutedMemoryLexicalCandidateProvider({
      breaker,
      configuration: { backend: "OPENSEARCH_CANARY", canaryPercent: 1 },
      openSearch,
      postgres,
      userScopeForUser: () => "0".repeat(64)
    });
    const notSelected = new RoutedMemoryLexicalCandidateProvider({
      breaker,
      configuration: { backend: "OPENSEARCH_CANARY", canaryPercent: 1 },
      openSearch,
      postgres,
      userScopeForUser: () => "f".repeat(64)
    });

    expect((await selected.search(request())).evidence.backend).toBe("OPENSEARCH");
    expect((await notSelected.search(request())).evidence.backend).toBe("POSTGRES");
    expect(openSearchCalls).toBe(1);
    expect(postgresCalls).toBe(1);
  });

  it("does not trust a malformed non-canary PostgreSQL provider result", async () => {
    const routed = new RoutedMemoryLexicalCandidateProvider({
      breaker: new MemoryLexicalCircuitBreaker({
        cooldownMs: 1_000,
        failureThreshold: 2
      }),
      configuration: { backend: "OPENSEARCH_CANARY", canaryPercent: 1 },
      openSearch: provider("OPENSEARCH", async () => result("OPENSEARCH")),
      postgres: provider("POSTGRES", async () => ({
        ...result("POSTGRES"),
        evidence: { ...result("POSTGRES").evidence, backend: "OPENSEARCH" }
      })),
      userScopeForUser: () => "f".repeat(64)
    });

    await expect(routed.search(request())).rejects.toThrow(
      "memory_lexical_search_result_invalid"
    );
  });

  it("falls back generically when projection is dirty without opening the breaker", async () => {
    let postgresDeadlineAtMs = 0;
    const breaker = new MemoryLexicalCircuitBreaker({
      cooldownMs: 1_000,
      failureThreshold: 1
    });
    const routed = new RoutedMemoryLexicalCandidateProvider({
      breaker,
      configuration: { backend: "OPENSEARCH", canaryPercent: 1 },
      openSearch: provider("OPENSEARCH", async () => result(
        "OPENSEARCH",
        "memory_lexical_projection_not_ready"
      )),
      postgres: provider("POSTGRES", async (input) => {
        postgresDeadlineAtMs = input.deadlineAtMs;
        return result("POSTGRES");
      })
    });

    const searched = await routed.search({ ...request(), deadlineAtMs: 1 });
    expect(searched.candidates[0]?.searchEntryId).toBe("postgres-entry-1");
    expect(searched.evidence).toMatchObject({
      backend: "POSTGRES",
      failureCode: "memory_lexical_projection_not_ready",
      fallbackUsed: true,
      projectionCaughtUp: false
    });
    expect(breaker.snapshot()).toEqual({
      consecutiveFailureCount: 0,
      state: "CLOSED"
    });
    expect(postgresDeadlineAtMs).toBeGreaterThan(Date.now());
  });

  it("opens on invalid OpenSearch responses and skips it until recovery", async () => {
    let openSearchCalls = 0;
    let postgresCalls = 0;
    let now = 1_000;
    const breaker = new MemoryLexicalCircuitBreaker({
      cooldownMs: 2_000,
      failureThreshold: 1
    }, () => now);
    const routed = new RoutedMemoryLexicalCandidateProvider({
      breaker,
      configuration: { backend: "OPENSEARCH", canaryPercent: 1 },
      openSearch: provider("OPENSEARCH", async () => {
        openSearchCalls += 1;
        return {
          ...result("OPENSEARCH"),
          evidence: { ...result("OPENSEARCH").evidence, backend: "POSTGRES" }
        };
      }),
      postgres: provider("POSTGRES", async () => {
        postgresCalls += 1;
        return result("POSTGRES");
      })
    });

    expect((await routed.search(request())).evidence.failureCode)
      .toBe("memory_opensearch_response_invalid");
    expect(breaker.snapshot().state).toBe("OPEN");
    expect((await routed.search(request())).evidence.failureCode)
      .toBe("memory_opensearch_circuit_open");
    expect(openSearchCalls).toBe(1);
    expect(postgresCalls).toBe(2);

    now += 2_000;
    expect((await routed.search(request())).evidence.failureCode)
      .toBe("memory_opensearch_response_invalid");
    expect(openSearchCalls).toBe(2);
  });

  it("falls back and counts an all-rejected canonical candidate set", async () => {
    const breaker = new MemoryLexicalCircuitBreaker({
      cooldownMs: 1_000,
      failureThreshold: 2
    });
    const routed = new RoutedMemoryLexicalCandidateProvider({
      breaker,
      configuration: { backend: "OPENSEARCH", canaryPercent: 1 },
      openSearch: provider("OPENSEARCH", async () => result("OPENSEARCH")),
      postgres: provider("POSTGRES", async () => result("POSTGRES"))
    });
    const input = request();
    const primary = await routed.search(input);

    const fallback = await routed.fallbackAfterCanonicalGuard(
      input,
      primary.evidence
    );
    expect(fallback.candidates[0]?.searchEntryId).toBe("postgres-entry-1");
    expect(fallback.evidence).toMatchObject({
      backend: "POSTGRES",
      failureCode: "memory_opensearch_canonical_guard",
      fallbackUsed: true,
      opaqueId: "opaque-request-1"
    });
    expect(breaker.snapshot()).toEqual({
      consecutiveFailureCount: 1,
      state: "CLOSED"
    });
  });
});
