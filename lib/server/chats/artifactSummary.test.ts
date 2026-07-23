import { describe, expect, it } from "vitest";
import { summarizeMessageRunArtifacts } from "./prismaRepository";

describe("summarizeMessageRunArtifacts", () => {
  it("uses native web search artifacts as expandable search details when search runs are absent", () => {
    const summary = summarizeMessageRunArtifacts({
      events: [
        {
          payload: {
            artifactType: "search",
            payload: {
              action: {
                sources: [{ title: "Example", url: "https://example.com" }],
                type: "search"
              },
              id: "ws_123",
              status: "completed",
              type: "web_search_call"
            }
          }
        }
      ],
      searchRuns: []
    });

    expect(summary).toMatchObject({
      searchCount: 1,
      searchDetails: [
        {
          callPreview: {
            action: {
              sources: [{ title: "Example", url: "https://example.com" }],
              type: "search"
            },
            id: "ws_123",
            status: "completed",
            type: "web_search_call"
          },
          status: "completed",
          strategyId: "openai-native-web-search"
        }
      ],
      searchStrategy: "openai-native-web-search"
    });
  });

  it("extracts reasoning summary text from provider arrays and ignores empty arrays", () => {
    const summary = summarizeMessageRunArtifacts({
      events: [
        {
          payload: {
            artifactType: "reasoning",
            payload: {
              reasoning: [{ text: "First summary", type: "summary_text" }]
            }
          }
        },
        {
          payload: {
            artifactType: "reasoning",
            payload: {
              summary: [{ text: "Second summary", type: "summary_text" }]
            }
          }
        },
        {
          payload: {
            artifactType: "reasoning",
            payload: {
              reasoning: []
            }
          }
        }
      ],
      searchRuns: []
    });

    expect(summary).toMatchObject({
      reasoningCount: 2,
      reasoningText: ["First summary", "Second summary"]
    });
  });

  it("uses the latest valid persisted context truncation artifact", () => {
    const summary = summarizeMessageRunArtifacts({
      events: [
        {
          payload: {
            artifactType: "context_truncated",
            payload: {
              approxDroppedTokens: 84,
              droppedMessages: 4
            }
          }
        },
        {
          payload: {
            artifactType: "context_truncated",
            payload: {
              approxDroppedTokens: 144,
              droppedMessages: 6
            }
          }
        },
        {
          payload: {
            artifactType: "context_truncated",
            payload: {
              approxDroppedTokens: 0,
              droppedMessages: 0
            }
          }
        }
      ],
      searchRuns: []
    });

    expect(summary).toMatchObject({
      contextTruncation: {
        approxDroppedTokens: 144,
        droppedMessages: 6
      }
    });
  });

  it("projects durable MCP calls when artifact append was interrupted", () => {
    const summary = summarizeMessageRunArtifacts({
      events: [],
      normalizedRequest: {
        mcp: {
          servers: [{
            credentialSources: ["personal"],
            externalAccountLabel: "Personal memory",
            fingerprint: "a".repeat(64),
            revisionId: "revision-1",
            serverId: "server-1",
            serverName: "Mem0"
          }],
          tools: [{
            definitionHash: "b".repeat(64),
            description: "Search memory",
            inputSchema: { type: "object" },
            name: "search",
            namespacedName: "mcp_mem0_search_1234567890",
            originalName: "search",
            serverId: "server-1",
            serverName: "Mem0"
          }],
          version: 1
        }
      },
      searchRuns: [],
      status: "complete",
      toolCalls: [{
        arguments: { apiKey: "sk-private-secret", query: "memory" },
        completedAt: "2026-07-23T12:00:00.050Z",
        mcpRunBindingId: "binding-1",
        ordinal: 0,
        providerCallId: "call-1",
        result: {
          callId: "call-1",
          content: [{ text: "found", type: "text" }],
          name: "mcp_mem0_search_1234567890",
          status: "complete"
        },
        roundIndex: 1,
        startedAt: "2026-07-23T12:00:00.000Z",
        state: "complete",
        toolName: "mcp_mem0_search_1234567890"
      }]
    });

    expect(summary).toMatchObject({
      toolCallCount: 1,
      toolCalls: [{
        argumentsPreview: { apiKey: "[redacted]", query: "memory" },
        durationMs: 50,
        serverName: "Mem0",
        status: "complete",
        toolName: "search"
      }]
    });
    expect(JSON.stringify(summary)).not.toContain("private-secret");
  });
});
