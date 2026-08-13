import { describe, expect, it } from "vitest";
import type { ThreadArtifactSummary } from "../../contracts/chats";
import { summarizeThreadRunEvidence } from "./runEvidenceSummary";

const emptyArtifacts: ThreadArtifactSummary = {
  citationCount: 0,
  citations: [],
  reasoningCount: 0,
  reasoningText: [],
  searchCount: 0,
  searchStrategy: null,
  toolCallCount: 0,
  toolCalls: []
};

function run(overrides: Record<string, unknown> = {}) {
  return {
    artifactSummary: emptyArtifacts,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    inputTokens: 0,
    normalizedRequest: { attachmentIds: [] },
    outputTokens: 0,
    reasoningTokens: 0,
    status: "complete",
    totalTokens: 0,
    usageEventCount: 0,
    ...overrides
  };
}

describe("summarizeThreadRunEvidence", () => {
  it("projects exact answer-bound counts from persisted terminal evidence", () => {
    expect(summarizeThreadRunEvidence(run({
      artifactSummary: {
        ...emptyArtifacts,
        citationCount: 3,
        searchActivity: [
          {
            displayName: "Search A",
            providerOperations: null,
            providerOperationsTruncated: false,
            query: "alpha",
            sourceCount: 2,
            sources: [],
            status: "complete"
          },
          {
            displayName: "Search B",
            providerOperations: null,
            providerOperationsTruncated: false,
            query: "beta",
            sourceCount: 4,
            sources: [],
            status: "partial"
          }
        ],
        toolCallCount: 2
      },
      normalizedRequest: { attachmentIds: ["file-a", "file-b", "file-a"] },
      usageEventCount: 1
    }))).toEqual({
      fileCount: 2,
      hasUsage: true,
      sourceCount: 6,
      toolCallCount: 2
    });
  });

  it("does not double-count citations and Search sources for the same answer", () => {
    expect(summarizeThreadRunEvidence(run({
      artifactSummary: {
        ...emptyArtifacts,
        citationCount: 8,
        searchActivity: [{
          displayName: "Search",
          providerOperations: null,
          providerOperationsTruncated: false,
          query: null,
          sourceCount: 3,
          sources: [],
          status: "complete"
        }]
      }
    }))?.sourceCount).toBe(8);
  });

  it("uses safe projected sources when a provider count is unavailable", () => {
    expect(summarizeThreadRunEvidence(run({
      artifactSummary: {
        ...emptyArtifacts,
        searchActivity: [{
          displayName: "Search",
          providerOperations: null,
          providerOperationsTruncated: false,
          query: null,
          sourceCount: null,
          sources: [
            { title: "One", url: "https://one.example" },
            { title: "Two", url: "https://two.example" }
          ],
          status: "partial"
        }]
      }
    }))?.sourceCount).toBe(2);
  });

  it("fails malformed attachment identity to zero and still reports token usage", () => {
    expect(summarizeThreadRunEvidence(run({
      inputTokens: 1,
      normalizedRequest: { attachmentIds: ["valid", 7] }
    }))).toEqual({
      fileCount: 0,
      hasUsage: true,
      sourceCount: 0,
      toolCallCount: 0
    });
  });

  it.each(["in_progress", "preparing", "queued", "streaming"])(
    "withholds a projection while the run is %s",
    (status) => {
      expect(summarizeThreadRunEvidence(run({ status }))).toBeNull();
    }
  );

  it.each(["cancelled", "complete", "error"])(
    "keeps a zero-fact terminal receipt for %s",
    (status) => {
      expect(summarizeThreadRunEvidence(run({ status }))).toEqual({
        fileCount: 0,
        hasUsage: false,
        sourceCount: 0,
        toolCallCount: 0
      });
    }
  );
});
