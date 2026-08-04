import { describe, expect, it } from "vitest";
import {
  providerSearchOperationsFromArtifacts,
  threadSearchExecutionsFromToolPreview
} from "./providerOperations";

describe("provider Search operation evidence", () => {
  it("merges lifecycle observations for one provider call and bounds action detail", () => {
    expect(providerSearchOperationsFromArtifacts([
      {
        data: {
          artifactType: "search",
          payload: {
            id: "ws-1",
            outputIndex: 0,
            status: "in_progress",
            type: "web_search_call"
          }
        },
        type: "artifact"
      },
      {
        data: {
          artifactType: "search",
          payload: {
            action: {
              query: "latest news in Moscow",
              queries: ["latest news in Moscow", "Moscow breaking news"],
              type: "search"
            },
            id: "ws-1",
            outputIndex: 0,
            status: "completed",
            type: "web_search_call"
          }
        },
        type: "artifact"
      }
    ])).toEqual({
      operations: [{
        id: "ws-1",
        kind: "search",
        ordinal: 0,
        pattern: null,
        queries: ["latest news in Moscow", "Moscow breaking news"],
        status: "complete",
        url: null
      }],
      truncated: false
    });
  });

  it("retains an honest truncation marker when bounded operation evidence is full", () => {
    const trace = providerSearchOperationsFromArtifacts(Array.from({ length: 32 }, (_, ordinal) => ({
      data: {
        artifactType: "search",
        payload: {
          action: {
            queries: Array.from({ length: 8 }, (_, queryOrdinal) =>
              `${ordinal}-${queryOrdinal}-${"x".repeat(507)}`),
            type: "search"
          },
          id: `ws-${ordinal}`,
          status: "completed",
          type: "web_search_call"
        }
      },
      type: "artifact" as const
    })));

    expect(trace.truncated).toBe(true);
    expect(trace.operations.length).toBeGreaterThan(0);
    expect(trace.operations.length).toBeLessThan(32);
    expect(Buffer.byteLength(JSON.stringify(trace.operations), "utf8")).toBeLessThanOrEqual(16 * 1_024);
  });

  it("keeps only a bounded cumulative Anthropic Web Search request count", () => {
    const artifact = (webSearchRequests: number) => ({
      data: {
        artifactType: "search" as const,
        payload: {
          action: { query: "bounded query", type: "search" },
          id: "anthropic-search-1",
          provider: "anthropic",
          status: "completed",
          type: "web_search_call",
          webSearchRequests
        }
      },
      type: "artifact" as const
    });

    expect(providerSearchOperationsFromArtifacts([
      artifact(1),
      artifact(3)
    ])).toMatchObject({
      providerUsage: { webSearchRequests: 3 }
    });
    expect(providerSearchOperationsFromArtifacts([
      artifact(1),
      artifact(101)
    ])).not.toHaveProperty("providerUsage");
  });

  it("projects historical Search executions with unavailable provider detail", () => {
    expect(threadSearchExecutionsFromToolPreview({
      finalProviderResponsePreview: {
        searchExecutions: [{
          durationMs: 145_800,
          invocationId: "opaque",
          modelId: "gpt-5.6-sol",
          optionId: "web-search-sol",
          provider: "openai-compatible",
          query: "latest news in Moscow",
          requestPreview: {},
          revisionId: "revision-1",
          sources: [{ rank: 1, title: "Source", url: "https://example.com" }],
          status: "complete",
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 }
        }]
      }
    })).toEqual([{
      displayName: "Search source",
      durationMs: 145_800,
      modelId: "gpt-5.6-sol",
      optionId: "web-search-sol",
      provider: "openai-compatible",
      providerOperations: null,
      providerOperationsTruncated: false,
      query: "latest news in Moscow",
      sourceCount: 1,
      sources: [{ rank: 1, title: "Source", url: "https://example.com" }],
      status: "complete",
      warning: null
    }]);
  });
});
