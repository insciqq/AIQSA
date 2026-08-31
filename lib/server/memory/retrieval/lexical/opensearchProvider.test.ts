import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { OpenSearchTransportError } from
  "../../../search/opensearch/coreTransport";
import type { MemoryOpenSearchClient } from
  "../../../search/opensearch/memoryClient";
import {
  MEMORY_OPENSEARCH_ANALYSIS_PROFILE,
  MEMORY_OPENSEARCH_BACKEND_KIND,
  MEMORY_OPENSEARCH_MAPPING_VERSION,
  MEMORY_OPENSEARCH_NORMALIZATION_VERSION,
  MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION,
  memoryOpenSearchConfigurationFromEnv,
  memoryOpenSearchProjectionFingerprint
} from "../../../search/opensearch/memoryContract";
import {
  memoryLexicalProjectionReadinessScope,
  type MemoryLexicalSearchRequest
} from "./contract";
import { OpenSearchMemoryLexicalCandidateProvider } from
  "./opensearchProvider";

const env: NodeJS.ProcessEnv = {
  AIQSA_MEMORY_OPENSEARCH_ROUTING_KEY: Buffer.alloc(32, 4).toString("base64"),
  AIQSA_MEMORY_OPENSEARCH_ROUTING_KEY_ID: "shadow-test-v1",
  NODE_ENV: "test"
};

function request(
  overrides: Partial<MemoryLexicalSearchRequest> = {}
): MemoryLexicalSearchRequest {
  return {
    activeGenerationId: "generation-1",
    analysisProfileVersion: "UNICODE_ICU_NGRAM_V1",
    candidateLimitPerVariant: 24,
    deadlineAtMs: Date.now() + 1_000,
    finalLimit: 12,
    itemFamily: "FACT",
    memoryRevisionSnapshot: 7,
    userId: "user-1",
    variants: [{
      logicalTerms: [{ characterLength: 5, ordinal: 0, value: "cedar" }],
      normalizedText: "cedar",
      ordinal: 0
    }],
    ...overrides
  };
}

function readinessRow(overrides: Record<string, unknown> = {}) {
  const configuration = memoryOpenSearchConfigurationFromEnv(env);
  return {
    analysisProfile: MEMORY_OPENSEARCH_ANALYSIS_PROFILE,
    backendKind: MEMORY_OPENSEARCH_BACKEND_KIND,
    enqueuedThroughSequence: 12n,
    expectedContentFingerprint: "a".repeat(64),
    expectedDocumentCount: 2,
    generationIndexedThroughMemoryRevision: 7,
    generationState: "ACTIVE",
    generationTargetMemoryRevision: 7,
    lastSuccessfulRefreshAt: new Date(),
    mappingVersion: MEMORY_OPENSEARCH_MAPPING_VERSION,
    noOutstandingEvents: true,
    normalizationVersion: MEMORY_OPENSEARCH_NORMALIZATION_VERSION,
    projectedThroughRevision: 7,
    projectionFingerprint: memoryOpenSearchProjectionFingerprint(configuration),
    readyAt: new Date(),
    retrievalPipelineVersion: MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION,
    status: "READY",
    targetMemoryRevision: 7,
    visibleContentFingerprint: "a".repeat(64),
    visibleDocumentCount: 2,
    visibleThroughSequence: 12n,
    ...overrides
  };
}

function database(rows: readonly unknown[]) {
  const $queryRaw = vi.fn(async (query: { strings?: readonly string[] }) =>
    query.strings?.join(" ").includes("set_config") ? [] : rows);
  const $transaction = vi.fn(async (
    callback: (tx: Readonly<{ $queryRaw: typeof $queryRaw }>) => Promise<unknown>
  ) => callback({ $queryRaw }));
  return {
    client: { $transaction } as unknown as PrismaClient,
    query: $queryRaw,
    transaction: $transaction
  };
}

function searchClient(
  implementation: MemoryOpenSearchClient["searchLexical"]
): MemoryOpenSearchClient {
  return { searchLexical: vi.fn(implementation) } as unknown as
    MemoryOpenSearchClient;
}

describe("OpenSearch Memory lexical provider", () => {
  it("queries only a revision-exact READY projection and preserves mixed match modes", async () => {
    const db = database([readinessRow()]);
    const search = searchClient(async () => ({
      candidates: [{
        backendScore: 2,
        matchedTermCount: 1,
        matchMode: "UNICODE",
        maximumMatchedTermLength: 5,
        rankWithinVariant: 1,
        safeContentHash: "a".repeat(64),
        searchEntryId: "entry-1",
        variantOrdinal: 0
      }, {
        backendScore: 1,
        matchedTermCount: 1,
        matchMode: "FOLDED",
        maximumMatchedTermLength: 5,
        rankWithinVariant: 2,
        safeContentHash: "b".repeat(64),
        searchEntryId: "entry-2",
        variantOrdinal: 0
      }],
      durationMs: 4,
      opaqueId: "aiqsa-memory-search-test"
    }));
    const provider = new OpenSearchMemoryLexicalCandidateProvider(
      db.client,
      "FACT_LEXICAL_UNICODE",
      search,
      env
    );

    const result = await provider.search(request());

    expect(search.searchLexical).toHaveBeenCalledWith(expect.objectContaining({
      phase: "PRIMARY"
    }));
    expect(result.evidence).toMatchObject({
      backend: "OPENSEARCH",
      failureCode: null,
      matchMode: null,
      projectionCaughtUp: true,
      projectionEventLag: 0,
      projectionRevisionLag: 0,
      rawCandidateCount: 2
    });
  });

  it("admits a later exact projection after the immutable generation build target", async () => {
    const db = database([readinessRow({
      generationIndexedThroughMemoryRevision: 7,
      generationTargetMemoryRevision: 6
    })]);
    const search = searchClient(async () => ({
      candidates: [],
      durationMs: 1,
      opaqueId: "aiqsa-memory-search-later-revision"
    }));
    const provider = new OpenSearchMemoryLexicalCandidateProvider(
      db.client,
      "FACT_LEXICAL_UNICODE",
      search,
      env
    );

    const result = await provider.search(request());

    expect(search.searchLexical).toHaveBeenCalledOnce();
    expect(result.evidence).toMatchObject({
      failureCode: null,
      projectionCaughtUp: true
    });
  });

  it("coalesces readiness across lexical lanes from one retrieval snapshot", async () => {
    const db = database([readinessRow()]);
    const search = searchClient(async () => ({
      candidates: [],
      durationMs: 1,
      opaqueId: "aiqsa-memory-search-coalesced-readiness"
    }));
    const unicode = new OpenSearchMemoryLexicalCandidateProvider(
      db.client,
      "FACT_LEXICAL_UNICODE",
      search,
      env
    );
    const ngram = new OpenSearchMemoryLexicalCandidateProvider(
      db.client,
      "FACT_LEXICAL_NGRAM",
      search,
      env
    );
    const scoped = request({
      [memoryLexicalProjectionReadinessScope]: Object.freeze({})
    });

    await unicode.prepare(scoped);
    const results = await Promise.all([
      unicode.search(scoped),
      ngram.search({ ...scoped, deadlineAtMs: Date.now() + 1_000 })
    ]);

    expect(results.map(({ evidence }) => evidence.failureCode)).toEqual([
      null,
      null
    ]);
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(search.searchLexical).toHaveBeenCalledTimes(2);
  });

  it("does not query a stale projection and reports bounded lag only", async () => {
    const db = database([readinessRow({
      enqueuedThroughSequence: 15n,
      projectedThroughRevision: 5,
      status: "CATCHING_UP",
      visibleThroughSequence: 12n
    })]);
    const search = searchClient(async () => {
      throw new Error("unexpected_search");
    });
    const provider = new OpenSearchMemoryLexicalCandidateProvider(
      db.client,
      "FACT_LEXICAL_UNICODE",
      search,
      env
    );

    const result = await provider.search(request());

    expect(search.searchLexical).not.toHaveBeenCalled();
    expect(result.candidates).toEqual([]);
    expect(result.evidence).toMatchObject({
      failureCode: "memory_lexical_projection_not_ready",
      projectionCaughtUp: false,
      projectionEventLag: 3,
      projectionRevisionLag: 2
    });
    expect(JSON.stringify(result.evidence)).not.toContain("user-1");
  });

  it("reduces transport failures to a content-free provider code", async () => {
    const db = database([readinessRow()]);
    const search = searchClient(async () => {
      throw new OpenSearchTransportError("opensearch_response_invalid");
    });
    const provider = new OpenSearchMemoryLexicalCandidateProvider(
      db.client,
      "FACT_LEXICAL_NGRAM",
      search,
      env
    );

    const result = await provider.search(request());

    expect(result.evidence).toMatchObject({
      failureCode: "memory_opensearch_response_invalid",
      fallbackUsed: true,
      projectionCaughtUp: true,
      timedOut: false
    });
    expect(result.candidates).toEqual([]);
  });
});
