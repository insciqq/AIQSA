import { describe, expect, it } from "vitest";
import {
  summarizeMessageRunArtifacts,
  summarizeMessageRunToolActivity
} from "./prismaRepository";

describe("summarizeMessageRunArtifacts", () => {
  it("projects only direct citations, Sources, and Reasoning", () => {
    const summary = summarizeMessageRunArtifacts({
      events: [
        {
          payload: {
            artifactType: "citation",
            payload: {
              routeId: "private-route",
              title: "Citation",
              url: "https://example.com/citation"
            }
          }
        },
        {
          payload: {
            artifactType: "reasoning",
            payload: { summary: "Compared the direct sources." }
          }
        },
        {
          payload: {
            artifactType: "search",
            payload: {
              action: {
                query: "private generated query",
                sources: [{
                  description: "Safe hosted snippet",
                  title: "Hosted source",
                  url: "https://example.com/hosted"
                }]
              },
              id: "private-provider-call"
            }
          }
        },
        {
          payload: {
            artifactType: "tool_result",
            payload: { resultPreview: { secret: true } }
          }
        },
        {
          payload: {
            artifactType: "context_truncated",
            payload: { approxDroppedTokens: 100, droppedMessages: 2 }
          }
        }
      ],
      searchRuns: [{
        artifacts: {
          providerOperations: [{ queries: ["private persisted query"] }],
          sources: [{
            rank: 4,
            snippet: "Safe persisted snippet",
            title: "Persisted source",
            url: "https://example.com/persisted"
          }]
        }
      }]
    });

    expect(summary).toEqual({
      citations: [{
        index: 1,
        title: "Citation",
        url: "https://example.com/citation"
      }],
      knowledgeCitations: [],
      reasoningText: ["Compared the direct sources."],
      sources: [
        {
          rank: 1,
          snippet: "Safe persisted snippet",
          title: "Persisted source",
          url: "https://example.com/persisted"
        },
        {
          rank: 2,
          snippet: "Safe hosted snippet",
          title: "Hosted source",
          url: "https://example.com/hosted"
        }
      ]
    });
    expect(JSON.stringify(summary)).not.toMatch(
      /private-route|private generated query|private-provider-call|private persisted query|tool_result|context_truncated/
    );
  });

  it("projects only cited Knowledge document labels without retrieval metadata", () => {
    const summary = summarizeMessageRunArtifacts({
      events: [],
      knowledgeRuns: [{
        invocationOrdinal: 1,
        results: [
          {
            baseName: "Policies",
            documentVersionNumber: 3,
            fileName: "handbook.pdf",
            handle: "K1.1",
            includedText: "private-passage-sentinel",
            knowledgeBaseId: "private-base-id",
            page: 12
          },
          {
            baseName: "Policies",
            fileName: "unused.pdf",
            handle: "K1.2",
            includedText: "unused-private-passage",
            knowledgeBaseId: "private-base-id",
            page: 4
          }
        ]
      }],
      searchRuns: []
    }, {
      blocks: [{ text: "The policy applies [K1.1].", type: "text" }]
    });

    expect(summary).toEqual({
      citations: [],
      knowledgeCitations: [{
        baseName: "Policies",
        fileName: "handbook.pdf",
        handle: "K1.1",
        page: 12
      }],
      reasoningText: [],
      sources: []
    });
    expect(JSON.stringify(summary)).not.toMatch(
      /private-passage-sentinel|unused\.pdf|private-base-id|documentVersionNumber/
    );
  });

  it("keeps only a committed Memory action", () => {
    const action = { operation: "UPDATE" as const, status: "COMMITTED" as const };
    const withAction = summarizeMessageRunArtifacts(
      { events: [], searchRuns: [] },
      undefined,
      action
    );
    const withoutAction = summarizeMessageRunArtifacts(
      { events: [], searchRuns: [] },
      undefined,
      null
    );

    expect(withAction).toEqual({
      citations: [],
      knowledgeCitations: [],
      memoryAction: action,
      reasoningText: [],
      sources: []
    });
    expect(withoutAction).toBeNull();
  });

  it("returns no artifact for execution-only records", () => {
    const run = {
      events: [{
        payload: {
          artifactType: "tool_result",
          payload: {
            argumentsPreview: { private: true },
            resultPreview: { private: true }
          }
        }
      }],
      normalizedRequest: { private: true },
      searchRuns: [],
      status: "complete",
      toolCalls: [{ result: { private: true } }]
    };

    expect(summarizeMessageRunArtifacts(run)).toBeNull();
  });
});

describe("summarizeMessageRunToolActivity", () => {
  it("projects ordered safe labels, status, duration, and an exhausted round warning", () => {
    const activity = summarizeMessageRunToolActivity({
      errorPayload: null,
      normalizedRequest: {
        mcp: {
          tools: [{
            namespacedName: "mcp_aws_search_123",
            originalName: "search_documentation",
            serverName: "AWS Documentation"
          }]
        },
        toolBudgets: { maxToolCalls: 20, maxToolRounds: 1 }
      },
      status: "complete",
      toolCalls: [
        {
          completedAt: new Date("2026-08-17T00:00:00.120Z"),
          ordinal: 0,
          roundIndex: 1,
          startedAt: new Date("2026-08-17T00:00:00.000Z"),
          state: "complete",
          toolName: "find_tools"
        },
        {
          completedAt: new Date("2026-08-17T00:00:00.500Z"),
          ordinal: 1,
          roundIndex: 1,
          startedAt: new Date("2026-08-17T00:00:00.200Z"),
          state: "error",
          toolName: "mcp_aws_search_123"
        }
      ]
    });

    expect(activity).toEqual({
      calls: [
        {
          durationMs: 120,
          round: 1,
          serverName: "Auto tools",
          status: "complete",
          toolName: "find_tools"
        },
        {
          durationMs: 300,
          round: 1,
          serverName: "AWS Documentation",
          status: "error",
          toolName: "search_documentation"
        }
      ],
      warning: { kind: "rounds", limit: 1 }
    });
    expect(JSON.stringify(activity)).not.toMatch(/arguments|result|namespacedName|mcp_aws/iu);
  });

  it("retains a call-limit warning when the rejected batch was not persisted", () => {
    expect(summarizeMessageRunToolActivity({
      errorPayload: { code: "tool_call_limit_exceeded" },
      normalizedRequest: { toolBudgets: { maxToolCalls: 20, maxToolRounds: 8 } },
      status: "error",
      toolCalls: []
    })).toEqual({
      calls: [],
      warning: { kind: "calls", limit: 20 }
    });
  });

  it("never falls back to an internal MCP namespace", () => {
    expect(summarizeMessageRunToolActivity({
      errorPayload: null,
      normalizedRequest: {},
      status: "complete",
      toolCalls: [{
        completedAt: null,
        ordinal: 0,
        roundIndex: 1,
        startedAt: null,
        state: "running",
        toolName: "mcp_private_internal_tool_0123456789"
      }]
    })?.calls[0]?.toolName).toBe("MCP tool");
  });
});
