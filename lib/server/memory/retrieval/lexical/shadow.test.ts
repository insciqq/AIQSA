import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryLaneCandidate } from
  "../../../../domain/memory/retrieval";
import type { MemoryLexicalLaneEvidence } from "./contract";
import {
  BoundedMemoryLexicalShadowRuntime,
  compareMemoryLexicalShadowRanks,
  memoryLexicalShadowLaneReceipt,
  type MemoryLexicalShadowReceipt
} from "./shadow";

function candidates(...entryIds: string[]): readonly MemoryLaneCandidate[] {
  return entryIds.map((entryId) => ({ entryId } as MemoryLaneCandidate));
}

function evidence(): MemoryLexicalLaneEvidence {
  return {
    backend: "OPENSEARCH",
    canonicalAcceptedCount: 2,
    durationMs: 8,
    failureCode: null,
    fallbackUsed: false,
    lane: "FACT_LEXICAL_UNICODE",
    matchMode: null,
    opaqueId: "aiqsa-memory-search-opaque",
    projectionCaughtUp: true,
    projectionEventLag: 0,
    projectionRevisionLag: 0,
    projectionVisibleAgeMs: 12,
    rawCandidateCount: 2,
    rejectedAuthorityCount: 0,
    rejectedGenerationCount: 0,
    rejectedHashCount: 0,
    requestedLimit: 20,
    timedOut: false
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Memory lexical shadow runtime", () => {
  it("computes identity-only top-k parity without calling it relevance", () => {
    const comparison = compareMemoryLexicalShadowRanks({
      candidate: candidates("entry-b", "entry-a", "entry-x"),
      reference: candidates("entry-a", "entry-b", "entry-c")
    });

    expect(comparison).toEqual({
      candidateTop10Count: 3,
      firstReferenceCandidateReciprocalRankDifference: -0.5,
      referenceTop10Count: 3,
      referenceTop10InCandidateTop50Count: 2,
      referenceTop10InCandidateTop50Ratio: 2 / 3,
      top10IntersectionCount: 2,
      top10Jaccard: 0.5
    });
    expect(comparison).not.toHaveProperty("firstRelevantReciprocalRankDifference");
  });

  it("emits lane metrics without entry identities or raw opaque IDs", () => {
    const receipt = memoryLexicalShadowLaneReceipt({
      candidate: candidates("secret-entry-b", "secret-entry-a"),
      lane: "FACT_LEXICAL_UNICODE",
      openSearchCandidates: [
        { matchMode: "UNICODE" },
        { matchMode: "FOLDED" }
      ],
      openSearchEvidence: evidence(),
      postgresCanonicalAcceptedCount: 2,
      postgresRawCandidateCount: 3,
      reference: candidates("secret-entry-a", "secret-entry-b")
    });

    expect(receipt.openSearch.matchModeCounts).toEqual({
      FOLDED: 1,
      NGRAM: 0,
      TRANSLITERATED: 0,
      UNICODE: 1
    });
    expect(receipt.openSearch.opaqueIdPresent).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain("secret-entry");
    expect(JSON.stringify(receipt)).not.toContain("aiqsa-memory-search-opaque");
  });

  it("drops excess detached work instead of creating a queue", async () => {
    const receipts: MemoryLexicalShadowReceipt[] = [];
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = new BoundedMemoryLexicalShadowRuntime(
      {} as PrismaClient,
      { backend: "SHADOW", maximumConcurrency: 1, timeoutMs: 1_000 },
      { NODE_ENV: "test" } as NodeJS.ProcessEnv,
      (receipt) => receipts.push(receipt)
    );

    expect(runtime.submit({
      stage: "ENRICHED",
      async work() {
        await pending;
        return [];
      }
    })).toBe(true);
    expect(runtime.submit({
      stage: "BASELINE",
      async work() {
        return [];
      }
    })).toBe(false);
    expect(receipts).toEqual([expect.objectContaining({
      failureCode: "memory_lexical_shadow_capacity",
      stage: "BASELINE"
    })]);

    release();
    await vi.waitFor(() => expect(receipts).toHaveLength(2));
    expect(receipts[1]).toMatchObject({
      failureCode: null,
      stage: "ENRICHED"
    });
  });

  it("reports the shadow deadline without delaying a caller", async () => {
    vi.useFakeTimers();
    const receipts: MemoryLexicalShadowReceipt[] = [];
    const runtime = new BoundedMemoryLexicalShadowRuntime(
      {} as PrismaClient,
      { backend: "SHADOW", maximumConcurrency: 1, timeoutMs: 250 },
      { NODE_ENV: "test" } as NodeJS.ProcessEnv,
      (receipt) => receipts.push(receipt)
    );

    expect(runtime.submit({
      stage: "INTRA_CHAT",
      async work() {
        await new Promise(() => undefined);
        return [];
      }
    })).toBe(true);
    expect(receipts).toEqual([]);
    await vi.advanceTimersByTimeAsync(250);
    expect(receipts).toEqual([expect.objectContaining({
      failureCode: "memory_lexical_settle_timeout",
      stage: "INTRA_CHAT",
      timedOut: true
    })]);
  });
});
