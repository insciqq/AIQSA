import { describe, expect, it } from "vitest";
import type { ProviderRunRequest } from "../providers/types";
import type { ToolExecutionResult } from "../tools/types";
import {
  automaticKnowledgeCoverageVerified,
  automaticKnowledgeEvidenceMessage,
  unavailableKnowledgeEvidenceMessage,
  withAutomaticKnowledgeEvidence
} from "./automaticEvidence";
import type { KnowledgePlannerPlan, KnowledgePlannerSubquery } from "./planner";
import {
  KNOWLEDGE_RESULT_VERSION,
  type KnowledgeRetrievalEvidence
} from "./retrievalTypes";
import { knowledgeToolResultContent, knowledgeToolResultText } from "./toolResult";

function request(): ProviderRunRequest {
  return {
    attachmentIds: [],
    attachments: [],
    chatId: "chat-1",
    content: { blocks: [{ text: "Question", type: "text" }] },
    context: {
      messages: [{
        content: { blocks: [{ text: "Question", type: "text" }] },
        id: "current-user-message",
        role: "user"
      }],
      mode: "branch_path"
    },
    knowledgePlan: { baseIds: ["base-1"], mode: "explicit", sourceIds: [], version: 1 },
    modelCapabilities: {
      contextWindow: 32_768,
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      toolCalling: false,
      vision: false
    },
    modelId: "answer-model",
    params: {},
    prompt: { developer: null, system: null },
    provider: "openai",
    searchPlan: { mode: "all_selected", options: [] },
    toolMode: "auto"
  };
}

function evidence(overrides: Partial<KnowledgeRetrievalEvidence> = {}): KnowledgeRetrievalEvidence {
  const passage = "Verified passage";
  const draft: KnowledgeRetrievalEvidence = {
    bases: [{
      baseContentRevision: 1,
      baseName: "Base",
      candidateCount: 1,
      indexedContentRevision: 1,
      indexGenerationId: "generation-1",
      knowledgeBaseId: "base-1",
      ordinal: 0,
      state: "ready",
      targetDimension: 1024,
      vectorSpaceFingerprint: "a".repeat(64)
    }],
    candidateCount: 1,
    candidateLimit: 40,
    durationMs: 3,
    embeddingExecutions: [{
      bindingOrdinals: [0],
      durationMs: 1,
      inputTokens: 1,
      modelId: "embedding-v1",
      provider: "openai_compatible",
      providerModelId: "embedding-deployment-1",
      requestId: null,
      status: "complete",
      totalTokens: 1
    }],
    fusion: "rrf_k60",
    invocationOrdinal: 1,
    outcome: "complete",
    postRerankOrder: null,
    preRerankOrder: null,
    providerText: "pending",
    query: "Question",
    rerankerBinding: null,
    resultLimit: 8,
    results: [{
      annRank: 1,
      baseName: "Base",
      bindingOrdinal: 0,
      chunkId: "chunk-1",
      chunkIndex: 0,
      documentId: "document-1",
      documentVersionId: "version-1",
      documentVersionNumber: 1,
      fileName: "source.txt",
      ftsRank: 1,
      ftsScore: 0.5,
      fusedScore: 2 / 61,
      handle: "K1.1",
      includedText: passage,
      includedTextBytes: Buffer.byteLength(passage),
      knowledgeBaseId: "base-1",
      page: 1,
      sourceTextBytes: Buffer.byteLength(passage),
      textTruncated: false,
      vectorDistance: 0.1,
      vectorScore: 0.9
    }],
    threshold: 0.01,
    version: KNOWLEDGE_RESULT_VERSION,
    ...overrides
  };
  return { ...draft, providerText: knowledgeToolResultText(draft) };
}

function result(callId: string, value: KnowledgeRetrievalEvidence): ToolExecutionResult {
  return {
    callId,
    content: knowledgeToolResultContent(value),
    name: "retrieve_knowledge",
    rawPreview: {
      knowledgeResultVersion: KNOWLEDGE_RESULT_VERSION,
      knowledgeRetrieval: value,
      providerCall: true
    },
    status: "complete"
  };
}

function subquery(overrides: Partial<KnowledgePlannerSubquery> = {}): KnowledgePlannerSubquery {
  return {
    exactTerms: [],
    lanes: ["semantic", "lexical"],
    ordinal: 0,
    purpose: "answer",
    query: "Question",
    targetNames: [],
    ...overrides
  };
}

function plan(overrides: Partial<KnowledgePlannerPlan> = {}): KnowledgePlannerPlan {
  return {
    automaticRetrieval: true,
    coverage: { expectedPassageCount: null, mode: "partial", namedTargets: [] },
    evidenceMode: "fuller",
    intent: "fact_lookup",
    originalQuery: "Question",
    rewrite: { exactTerms: [], query: "Question" },
    status: "ready",
    strategy: "focused",
    subqueries: [subquery()],
    version: 1,
    ...overrides
  };
}

describe("automatic Knowledge evidence", () => {
  it("qualifies an unavailable selected scope without inventing source evidence", () => {
    const message = unavailableKnowledgeEvidenceMessage({
      exclusions: [{ count: 2, reason: "not_ready", resourceType: "source" }]
    });
    const text = JSON.stringify(message.content);

    expect(text).toContain("No ready private Knowledge evidence");
    expect(text).toContain("2 selected Knowledge resource(s) could not be read");
    expect(text).toContain("Do not infer or invent source contents");
    expect(text).not.toContain("source-1");
  });

  it("marks bounded small-source context complete only when every expected passage is intact", () => {
    const planner = plan({
      coverage: { expectedPassageCount: 1, mode: "verified_only", namedTargets: [] },
      intent: "single_source_summary",
      strategy: "full_context"
    });
    const branches = [{ result: result("knowledge-planner-v1-1", evidence()), subquery: subquery() }];

    expect(automaticKnowledgeCoverageVerified(planner, branches)).toBe(true);
    const message = automaticKnowledgeEvidenceMessage({ branches, plan: planner, request: request() });
    expect(JSON.stringify(message.content)).toContain("Coverage verified: yes");
  });

  it("never converts an exhaustive request into an unchecked completeness claim", () => {
    const planner = plan({
      coverage: { expectedPassageCount: null, mode: "verified_only", namedTargets: [] },
      intent: "exhaustive_corpus_search",
      strategy: "exhaustive",
      subqueries: [subquery({ purpose: "coverage" })]
    });
    const branches = [{
      result: result("knowledge-planner-v1-1", evidence()),
      subquery: planner.subqueries[0]!
    }];
    const message = automaticKnowledgeEvidenceMessage({ branches, plan: planner, request: request() });
    const text = JSON.stringify(message.content);

    expect(automaticKnowledgeCoverageVerified(planner, branches)).toBe(false);
    expect(text).toContain("Coverage verified: no");
    expect(text).toContain("Do not claim that all sources");
  });

  it("reports comparison target gaps and keeps evidence hidden immediately before the user turn", () => {
    const first = subquery({ ordinal: 0, purpose: "compare_target", targetNames: ["Alpha"] });
    const second = subquery({ ordinal: 1, purpose: "compare_target", targetNames: ["Beta"] });
    const planner = plan({
      coverage: {
        expectedPassageCount: null,
        mode: "partial",
        namedTargets: ["Alpha", "Beta"]
      },
      intent: "multi_source_comparison",
      strategy: "comparison",
      subqueries: [first, second]
    });
    const missing: ToolExecutionResult = {
      callId: "knowledge-planner-v1-2",
      content: [{ text: "No evidence found.", type: "text" }],
      name: "retrieve_knowledge",
      status: "error"
    };
    const message = automaticKnowledgeEvidenceMessage({
      branches: [
        { result: result("knowledge-planner-v1-1", evidence()), subquery: first },
        { result: missing, subquery: second }
      ],
      plan: planner,
      request: request()
    });
    const materialized = withAutomaticKnowledgeEvidence(request(), message);

    expect(JSON.stringify(message.content)).toContain("Evidence found for every target: no");
    expect(JSON.stringify(message.content)).toContain(
      "Different values tied to different dates or versions are a timeline or comparison"
    );
    expect(JSON.stringify(message.content)).toContain(
      "A Source-derived answer with zero exact [K…] handles is invalid"
    );
    expect(JSON.stringify(message.content)).toContain("[K1][K2]");
    expect(materialized.context?.messages.map(({ id }) => id)).toEqual([
      "knowledge-evidence:v2",
      "current-user-message"
    ]);
  });

  it("does not treat one result from a grouped branch as evidence for every target", () => {
    const grouped = subquery({
      ordinal: 0,
      purpose: "compare_target",
      targetNames: ["Alpha", "Beta"]
    });
    const planner = plan({
      coverage: {
        expectedPassageCount: null,
        mode: "partial",
        namedTargets: ["Alpha", "Beta"]
      },
      intent: "multi_source_comparison",
      strategy: "comparison",
      subqueries: [grouped]
    });
    const alphaEvidence = evidence({
      results: [{
        ...evidence().results[0]!,
        includedText: "Alpha contract terms",
        includedTextBytes: Buffer.byteLength("Alpha contract terms"),
        sourceTextBytes: Buffer.byteLength("Alpha contract terms")
      }]
    });
    const message = automaticKnowledgeEvidenceMessage({
      branches: [{ result: result("knowledge-planner-v1-1", alphaEvidence), subquery: grouped }],
      plan: planner,
      request: request()
    });

    const allEvidence = evidence({
      results: [{
        ...evidence().results[0]!,
        includedText: "Alpha and Beta contract terms",
        includedTextBytes: Buffer.byteLength("Alpha and Beta contract terms"),
        sourceTextBytes: Buffer.byteLength("Alpha and Beta contract terms")
      }]
    });
    const completeMessage = automaticKnowledgeEvidenceMessage({
      branches: [{ result: result("knowledge-planner-v1-1", allEvidence), subquery: grouped }],
      plan: planner,
      request: request()
    });

    expect(JSON.stringify(message.content)).toContain("Evidence found for every target: no");
    expect(JSON.stringify(completeMessage.content)).toContain("Evidence found for every target: yes");
  });
});
