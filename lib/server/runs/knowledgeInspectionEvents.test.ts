import { describe, expect, it } from "vitest";
import type { KnowledgeRunProjection } from "../../contracts/runs";
import { projectKnowledgeInspectionEvents } from "./knowledgeInspectionEvents";

function receipt(
  overrides: Partial<KnowledgeRunProjection> = {}
): KnowledgeRunProjection {
  return {
    baseEvidence: [{
      baseContentRevision: 3,
      baseName: "Policies",
      candidateCount: 3,
      indexedContentRevision: 3,
      knowledgeBaseId: "base-1",
      ordinal: 0,
      state: "ready"
    }],
    candidateCount: 3,
    candidateLimit: 12,
    createdAt: "2026-08-08T10:00:00.000Z",
    durationMs: 42,
    embeddingUsage: [{ inputTokens: 2, totalTokens: 2 }],
    failureCode: null,
    fusion: "rrf_k60",
    id: "receipt-1",
    invocationOrdinal: 1,
    modelRunToolCallId: "stored-call-1",
    outcome: "complete",
    postRerankOrder: null,
    preRerankOrder: null,
    providerText: "private provider passage",
    query: "release policy",
    rerankerBinding: null,
    resultLimit: 6,
    results: [{
      baseName: "Policies",
      bindingOrdinal: 0,
      fileName: "release.md",
      fusedScore: 0.91,
      handle: "K1.1",
      includedText: "private passage",
      includedTextBytes: 15,
      knowledgeBaseId: "base-1",
      page: 1,
      sourceTextBytes: 15,
      textTruncated: false
    }],
    threshold: 0.2,
    ...overrides
  };
}

describe("projectKnowledgeInspectionEvents", () => {
  it("places a passage-free digest after the matching tool result", () => {
    const events = projectKnowledgeInspectionEvents({
      events: [
        {
          eventType: "artifact",
          payload: {
            artifactType: "tool_result",
            payload: { callId: "provider-call-1", status: "complete" }
          },
          sequence: 7
        },
        { eventType: "usage", payload: { totalTokens: 10 }, sequence: 8 },
        { eventType: "done", payload: { status: "complete" }, sequence: 9 }
      ],
      knowledgeRuns: [receipt()],
      toolCalls: [{ id: "stored-call-1", providerCallId: "provider-call-1" }]
    });

    expect(events.map((event) => event.eventType)).toEqual([
      "artifact",
      "knowledge_retrieval",
      "usage",
      "done"
    ]);
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3]);
    expect(events[1]?.payload).toEqual({
      candidateCount: 3,
      durationMs: 42,
      invocationOrdinal: 1,
      outcome: "complete",
      query: "release policy",
      resultCount: 1
    });
    expect(JSON.stringify(events)).not.toContain("private passage");
    expect(JSON.stringify(events)).not.toContain("private provider passage");
    expect(JSON.stringify(events)).not.toContain("stored-call-1");
  });

  it("keeps an unmatched recovery receipt before terminal rows", () => {
    const events = projectKnowledgeInspectionEvents({
      events: [
        { eventType: "token", payload: { delta: "answer" }, sequence: 2 },
        { eventType: "error", payload: { code: "interrupted" }, sequence: 3 }
      ],
      knowledgeRuns: [receipt({ modelRunToolCallId: "missing-call" })],
      toolCalls: []
    });

    expect(events.map((event) => event.eventType)).toEqual([
      "token",
      "knowledge_retrieval",
      "error"
    ]);
  });

  it("preserves stored sequences when the run has no Knowledge receipts", () => {
    const events = projectKnowledgeInspectionEvents({
      events: [
        { eventType: "token", payload: { delta: "answer" }, sequence: 7 },
        { eventType: "done", payload: { status: "complete" }, sequence: 11 }
      ],
      knowledgeRuns: [],
      toolCalls: []
    });

    expect(events.map((event) => event.sequence)).toEqual([7, 11]);
  });

  it("does not duplicate a receipt for repeated tool results or an existing digest", () => {
    const repeatedResult = {
      eventType: "artifact",
      payload: {
        artifactType: "tool_result",
        payload: { callId: "provider-call-1", status: "complete" }
      },
      sequence: 4
    };
    const projectedRepeated = projectKnowledgeInspectionEvents({
      events: [repeatedResult, { ...repeatedResult, sequence: 5 }],
      knowledgeRuns: [receipt()],
      toolCalls: [{ id: "stored-call-1", providerCallId: "provider-call-1" }]
    });
    expect(projectedRepeated.filter((event) => event.eventType === "knowledge_retrieval"))
      .toHaveLength(1);

    const projectedExisting = projectKnowledgeInspectionEvents({
      events: [
        repeatedResult,
        {
          eventType: "knowledge_retrieval",
          payload: { invocationOrdinal: 1, outcome: "complete" },
          sequence: 5
        }
      ],
      knowledgeRuns: [receipt()],
      toolCalls: [{ id: "stored-call-1", providerCallId: "provider-call-1" }]
    });
    expect(projectedExisting.filter((event) => event.eventType === "knowledge_retrieval"))
      .toHaveLength(1);
  });
});
