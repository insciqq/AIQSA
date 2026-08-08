import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { PersistedRun, ThreadArtifactSummary } from "./types";
import { KnowledgeEvidenceBlock } from "./KnowledgeEvidenceBlock";

const summary: ThreadArtifactSummary = {
  citationCount: 0,
  citations: [],
  knowledgeCitations: [{
    baseName: "Policies",
    documentVersionNumber: 3,
    fileName: "handbook.pdf",
    handle: "K1.1",
    knowledgeBaseId: "base-policies",
    page: 12
  }],
  knowledgeInvocationCount: 2,
  knowledgeOutcomes: [
    { invocationOrdinal: 1, outcome: "complete" },
    { invocationOrdinal: 2, outcome: "zero_above_threshold" }
  ],
  reasoningCount: 0,
  reasoningText: [],
  searchCount: 0,
  searchStrategy: null,
  toolCallCount: 0,
  toolCalls: []
};

const run: PersistedRun = {
  assistant: null,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  errorPayload: null,
  estimatedCostMicros: null,
  events: [],
  id: "run-knowledge",
  inputTokens: 10,
  knowledgeBindings: [],
  knowledgePlan: { baseIds: [] },
  knowledgeRuns: [{
    baseEvidence: [{
      baseContentRevision: 8,
      baseName: "Policies",
      candidateCount: 4,
      indexedContentRevision: 8,
      knowledgeBaseId: "base-policies",
      ordinal: 0,
      state: "ready"
    }],
    candidateCount: 4,
    candidateLimit: 40,
    createdAt: "2026-08-08T12:00:00.000Z",
    durationMs: 15,
    embeddingUsage: [{ inputTokens: 2, totalTokens: 2 }],
    failureCode: null,
    fusion: "rrf_k60",
    id: "receipt-1",
    invocationOrdinal: 1,
    modelRunToolCallId: "tool-1",
    outcome: "complete",
    postRerankOrder: null,
    preRerankOrder: null,
    providerText: "Evidence returned.",
    query: "retention policy",
    rerankerBinding: null,
    resultLimit: 8,
    results: [{
      baseName: "Policies",
      bindingOrdinal: 0,
      documentVersionNumber: 3,
      fileName: "handbook.pdf",
      fusedScore: 0.031746,
      handle: "K1.1",
      includedText: "The exact persisted passage.",
      includedTextBytes: 28,
      knowledgeBaseId: "base-policies",
      page: 12,
      sourceTextBytes: 44,
      textTruncated: true
    }],
    threshold: 0.01
  }, {
    baseEvidence: [{
      baseContentRevision: 8,
      baseName: "Policies",
      candidateCount: 2,
      indexedContentRevision: 8,
      knowledgeBaseId: "base-policies",
      ordinal: 0,
      state: "ready"
    }],
    candidateCount: 2,
    candidateLimit: 40,
    createdAt: "2026-08-08T12:00:01.000Z",
    durationMs: 11,
    embeddingUsage: [{ inputTokens: 2, totalTokens: 2 }],
    failureCode: null,
    fusion: "rrf_k60",
    id: "receipt-2",
    invocationOrdinal: 2,
    modelRunToolCallId: "tool-2",
    outcome: "zero_above_threshold",
    postRerankOrder: null,
    preRerankOrder: null,
    providerText: "No passage was above the threshold.",
    query: "superseded retention appendix",
    rerankerBinding: null,
    resultLimit: 8,
    results: [],
    threshold: 0.01
  }],
  modelId: "model-1",
  outputTokens: 20,
  provider: "provider-1",
  reasoningTokens: 0,
  searchRuns: [],
  status: "complete",
  toolCalls: [],
  totalTokens: 30
};

function Harness({ onOpenEvidence }: { onOpenEvidence(knowledgeBaseId: string): void }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <KnowledgeEvidenceBlock
      expanded={expanded}
      loading={false}
      persistedRun={run}
      showCitations
      summary={summary}
      onExpandedChange={setExpanded}
      onOpenEvidence={onOpenEvidence}
    />
  );
}

describe("KnowledgeEvidenceBlock", () => {
  it("shows stable citations and keeps the exact receipt collapsed by default", () => {
    const onOpenEvidence = vi.fn();
    render(<Harness onOpenEvidence={onOpenEvidence} />);

    expect(screen.getByText("handbook.pdf")).toBeVisible();
    expect(screen.getByText(/version 3 · page 12/)).toBeVisible();
    const disclosure = screen.getByRole("button", { name: /Knowledge 2 invocations/ });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByTitle("Open Policies evidence detail"));
    expect(onOpenEvidence).toHaveBeenCalledWith("base-policies");

    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Invocation 1")).toBeInTheDocument();
    expect(screen.getByText("Invocation 2")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Invocation 1").closest("summary")!);
    fireEvent.click(screen.getByText("Invocation 2").closest("summary")!);
    expect(screen.getByText("retention policy")).toBeInTheDocument();
    expect(screen.getByText("superseded retention appendix")).toBeInTheDocument();
    expect(screen.getByText("The exact persisted passage.")).toBeInTheDocument();
    expect(screen.getByText(/truncated at the persisted inclusion boundary/)).toBeInTheDocument();
    expect(screen.getByText((_, node) =>
      node?.tagName === "DIV" &&
      node.textContent === "No passage above threshold · no answer passage was included by this invocation."
    )).toBeVisible();
    expect(screen.getAllByText("15 ms")).not.toHaveLength(0);
    expect(screen.getAllByText("11 ms")).not.toHaveLength(0);
  });
});
