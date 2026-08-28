import { describe, expect, it, vi } from "vitest";
import { RerankAdapterError, type RerankAdapter } from "../providers/rerank";
import { decodeKnowledgeRerankerBindingEvidenceV2 } from "./rerankEvidence";
import {
  createKnowledgeRerankStage,
  KNOWLEDGE_RERANK_ADAPTER_VERSION,
  KNOWLEDGE_RERANK_TIMEOUT_MS,
  knowledgeRerankerDisabledEvidence,
  knowledgeRerankerUnavailableEvidence,
  type KnowledgeRerankPin
} from "./rerankExecution";

const pin: KnowledgeRerankPin = Object.freeze({
  adapterVersion: KNOWLEDGE_RERANK_ADAPTER_VERSION,
  candidateFormatterVersion: 1,
  connectionSnapshotId: "connection-1#v2",
  credentialSnapshotRef: "credential-version-1",
  policyVersion: 5,
  provider: "openrouter",
  providerModelId: "deployment-1",
  upstreamModelId: "qwen/qwen3-reranker-8b"
});

function candidate(chunkId: string, text = `passage for ${chunkId}`) {
  return { chunkId, headingPath: ["Раздел"], sourceName: "источник.pdf", text };
}

function fakeAdapter(rerank: RerankAdapter["rerank"]): RerankAdapter {
  return Object.freeze({ rerank });
}

describe("Knowledge rerank execution stage", () => {
  it("keeps the fifteen-second wall-clock default", () => {
    expect(KNOWLEDGE_RERANK_TIMEOUT_MS).toBe(15_000);
  });

  it("makes exactly one provider request with the full candidate set as top_n input", async () => {
    const rerank = vi.fn(async (request: Parameters<RerankAdapter["rerank"]>[0]) => ({
      model: "qwen3-reranker-8b",
      provider: "DeepInfra",
      requestId: "req-9",
      scores: request.documents.map((document, index) => ({
        handle: document.handle,
        index,
        relevanceScore: 1 - index * 0.2
      })),
      usage: { inputTokens: 40, searchUnits: 1, totalTokens: 40 }
    }));
    const stage = createKnowledgeRerankStage({ adapter: fakeAdapter(rerank), pin, query: "q" });
    const result = await stage({
      candidates: [candidate("chunk-a"), candidate("chunk-b"), candidate("chunk-c")]
    });
    expect(rerank).toHaveBeenCalledOnce();
    expect(rerank.mock.calls[0]![0].documents.map((document) => document.handle))
      .toEqual(["chunk-a", "chunk-b", "chunk-c"]);
    expect(result.status).toBe("complete");
    expect([...result.scores.entries()]).toEqual([
      ["chunk-a", 1],
      ["chunk-b", 0.8],
      ["chunk-c", expect.closeTo(0.6, 10)]
    ]);
    expect(result.evidence).toMatchObject({
      adapterVersion: KNOWLEDGE_RERANK_ADAPTER_VERSION,
      candidateFormatterVersion: 1,
      fallbackReason: null,
      inputCandidateCount: 3,
      orderedCandidateChunkIds: ["chunk-a", "chunk-b", "chunk-c"],
      outputOrder: ["chunk-a", "chunk-b", "chunk-c"],
      policyVersion: 5,
      provider: "DeepInfra",
      providerModelId: "deployment-1",
      providerRequestId: "req-9",
      status: "complete",
      timedOut: false,
      upstreamModelId: "qwen/qwen3-reranker-8b",
      usage: { searchUnits: 1, totalTokens: 40 },
      version: 2
    });
    expect(decodeKnowledgeRerankerBindingEvidenceV2(result.evidence)).not.toBeNull();
  });

  it("records a monotonic integer duration across a backward wall-clock step", async () => {
    const ticks = [50.5, 63.9];
    const now = vi.fn(() => {
      const tick = ticks.shift();
      if (tick === undefined) throw new Error("unexpected_monotonic_clock_read");
      return tick;
    });
    let wallNow = 2_000;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => wallNow);
    try {
      const stage = createKnowledgeRerankStage({
        adapter: fakeAdapter(async (request) => {
          const wallStartedAt = Date.now();
          wallNow = 1_000;
          expect(Date.now()).toBeLessThan(wallStartedAt);
          return {
            model: "qwen3-reranker-8b",
            provider: "DeepInfra",
            requestId: "req-clock-step",
            scores: request.documents.map((document, index) => ({
              handle: document.handle,
              index,
              relevanceScore: 1 - index * 0.1
            })),
            usage: { inputTokens: 2, searchUnits: 1, totalTokens: 2 }
          };
        }),
        now,
        pin,
        query: "q"
      });

      const result = await stage({
        candidates: [candidate("chunk-a"), candidate("chunk-b")]
      });
      expect(result.evidence.durationMs).toBe(13);
      expect(decodeKnowledgeRerankerBindingEvidenceV2(result.evidence)).not.toBeNull();
    } finally {
      dateNow.mockRestore();
    }
  });

  it("formats candidates without English labels and never sends chunk metadata prose", async () => {
    const rerank = vi.fn(async (request: Parameters<RerankAdapter["rerank"]>[0]) => ({
      model: "qwen3-reranker-8b",
      provider: null,
      requestId: null,
      scores: [{ handle: request.documents[0]!.handle, index: 0, relevanceScore: 0.5 },
        { handle: request.documents[1]!.handle, index: 1, relevanceScore: 0.4 }],
      usage: { inputTokens: null, searchUnits: null, totalTokens: null }
    }));
    const stage = createKnowledgeRerankStage({ adapter: fakeAdapter(rerank), pin, query: "q" });
    await stage({ candidates: [candidate("chunk-a"), candidate("chunk-b")] });
    for (const document of rerank.mock.calls[0]![0].documents) {
      expect(document.text).toBe(`источник.pdf\nРаздел\npassage for ${document.handle}`);
      expect(document.text).not.toMatch(/Source:|Location:|Evidence layout:/u);
    }
  });

  it("skips the provider for zero or one unique candidate", async () => {
    const rerank = vi.fn();
    const stage = createKnowledgeRerankStage({ adapter: fakeAdapter(rerank), pin, query: "q" });

    const single = await stage({ candidates: [candidate("chunk-a")] });
    expect(rerank).not.toHaveBeenCalled();
    expect(single.status).toBe("complete");
    expect(single.scores.size).toBe(0);
    expect(single.evidence).toMatchObject({
      inputCandidateCount: 1,
      orderedCandidateChunkIds: ["chunk-a"],
      outputOrder: ["chunk-a"],
      relevanceScores: [null],
      status: "complete"
    });
    expect(decodeKnowledgeRerankerBindingEvidenceV2(single.evidence)).not.toBeNull();

    const empty = await stage({ candidates: [] });
    expect(rerank).not.toHaveBeenCalled();
    expect(empty.evidence.inputCandidateCount).toBe(0);
  });

  it("returns a partial result ordered by score with omitted candidates in pre-rerank order", async () => {
    const stage = createKnowledgeRerankStage({
      adapter: fakeAdapter(async () => ({
        model: "qwen3-reranker-8b",
        provider: null,
        requestId: null,
        scores: [
          { handle: "chunk-c", index: 2, relevanceScore: 0.9 },
          { handle: "chunk-a", index: 0, relevanceScore: 0.2 }
        ],
        usage: { inputTokens: null, searchUnits: null, totalTokens: 30 }
      })),
      pin,
      query: "q"
    });
    const result = await stage({
      candidates: [candidate("chunk-a"), candidate("chunk-b"), candidate("chunk-c")]
    });
    expect(result.status).toBe("partial");
    expect(result.evidence.outputOrder).toEqual(["chunk-c", "chunk-a", "chunk-b"]);
    expect(result.evidence.relevanceScores).toEqual([0.9, 0.2, null]);
    expect(decodeKnowledgeRerankerBindingEvidenceV2(result.evidence)).not.toBeNull();
  });

  it("accepts an empty structurally valid response as a zero-score partial result", async () => {
    const stage = createKnowledgeRerankStage({
      adapter: fakeAdapter(async () => ({
        model: "qwen3-reranker-8b",
        provider: null,
        requestId: "req-empty",
        scores: [],
        usage: { inputTokens: null, searchUnits: 1, totalTokens: 10 }
      })),
      pin,
      query: "q"
    });
    const result = await stage({
      candidates: [candidate("chunk-a"), candidate("chunk-b")]
    });

    expect(result.status).toBe("partial");
    expect(result.evidence).toMatchObject({
      outputOrder: ["chunk-a", "chunk-b"],
      relevanceScores: [null, null],
      status: "partial"
    });
    expect(decodeKnowledgeRerankerBindingEvidenceV2(result.evidence)).not.toBeNull();
  });

  it("degrades with a timeout indicator when the wall-clock deadline fires", async () => {
    const stage = createKnowledgeRerankStage({
      adapter: fakeAdapter((request) => new Promise((_, reject) => {
        request.signal?.addEventListener("abort", () =>
          reject(new RerankAdapterError("rerank_provider_request_failed")));
      })),
      pin,
      query: "q",
      timeoutMs: 5
    });
    const result = await stage({ candidates: [candidate("chunk-a"), candidate("chunk-b")] });
    expect(result.status).toBe("degraded");
    expect(result.evidence).toMatchObject({
      fallbackReason: "rerank_request_timed_out",
      status: "degraded",
      timedOut: true
    });
    expect(decodeKnowledgeRerankerBindingEvidenceV2(result.evidence)).not.toBeNull();
  });

  it("enforces the wall-clock deadline when an adapter ignores AbortSignal", async () => {
    const stage = createKnowledgeRerankStage({
      adapter: fakeAdapter(() => new Promise(() => undefined)),
      pin,
      query: "q",
      timeoutMs: 5
    });
    const result = await stage({ candidates: [candidate("chunk-a"), candidate("chunk-b")] });
    expect(result.status).toBe("degraded");
    expect(result.evidence).toMatchObject({
      fallbackReason: "rerank_request_timed_out",
      timedOut: true
    });
  });

  it("degrades on classified provider failures and malformed responses", async () => {
    for (const code of [
      "rerank_provider_http_error",
      "rerank_provider_request_failed",
      "rerank_response_invalid",
      "rerank_response_model_mismatch"
    ] as const) {
      const stage = createKnowledgeRerankStage({
        adapter: fakeAdapter(async () => {
          throw new RerankAdapterError(code, code === "rerank_provider_http_error"
            ? { httpStatus: 429 }
            : {});
        }),
        pin,
        query: "q"
      });
      const result = await stage({ candidates: [candidate("chunk-a"), candidate("chunk-b")] });
      expect(result.status).toBe("degraded");
      expect(result.scores.size).toBe(0);
      expect(result.evidence.fallbackReason).toBe(code);
      expect(result.evidence.timedOut).toBe(false);
      expect(decodeKnowledgeRerankerBindingEvidenceV2(result.evidence)).not.toBeNull();
    }
  });

  it("never masks unclassified failures or cancellation as reranker fallback", async () => {
    const stage = createKnowledgeRerankStage({
      adapter: fakeAdapter(async () => {
        throw new Error("database_gone");
      }),
      pin,
      query: "q"
    });
    await expect(stage({ candidates: [candidate("chunk-a"), candidate("chunk-b")] }))
      .rejects.toThrow("database_gone");

    const invalidInput = createKnowledgeRerankStage({
      adapter: fakeAdapter(async () => {
        throw new RerankAdapterError("rerank_input_invalid");
      }),
      pin,
      query: "q"
    });
    await expect(invalidInput({
      candidates: [candidate("chunk-a"), candidate("chunk-b")]
    })).rejects.toMatchObject({ code: "rerank_input_invalid" });

    const cancelled = new AbortController();
    const cancelStage = createKnowledgeRerankStage({
      adapter: fakeAdapter((request) => new Promise((_, reject) => {
        request.signal?.addEventListener("abort", () =>
          reject(new RerankAdapterError("rerank_provider_request_failed")));
      })),
      pin,
      query: "q"
    });
    const pending = cancelStage({
      candidates: [candidate("chunk-a"), candidate("chunk-b")],
      signal: cancelled.signal
    });
    cancelled.abort(new Error("operation_cancelled"));
    await expect(pending).rejects.toThrow("operation_cancelled");

    const ignored = new AbortController();
    const ignoresAbort = createKnowledgeRerankStage({
      adapter: fakeAdapter(() => new Promise(() => undefined)),
      pin,
      query: "q",
      timeoutMs: 1_000
    });
    const ignoredPending = ignoresAbort({
      candidates: [candidate("chunk-a"), candidate("chunk-b")],
      signal: ignored.signal
    });
    ignored.abort(new Error("ignored_adapter_cancelled"));
    await expect(ignoredPending).rejects.toThrow("ignored_adapter_cancelled");
  });

  it("provides disabled and unavailable fallback evidence builders", () => {
    expect(knowledgeRerankerDisabledEvidence()).toMatchObject({
      inputCandidateCount: 0,
      status: "disabled",
      version: 2
    });
    expect(decodeKnowledgeRerankerBindingEvidenceV2(
      knowledgeRerankerDisabledEvidence()
    )).not.toBeNull();
    const unavailable = knowledgeRerankerUnavailableEvidence({
      selectedProviderModelId: "deployment-1"
    });
    expect(unavailable).toMatchObject({
      fallbackReason: "reranker_model_unavailable",
      providerModelId: "deployment-1",
      status: "degraded"
    });
    expect(decodeKnowledgeRerankerBindingEvidenceV2(unavailable)).not.toBeNull();
  });
});
