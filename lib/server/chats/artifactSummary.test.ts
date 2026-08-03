import { describe, expect, it } from "vitest";
import { summarizeMessageRunArtifacts } from "./prismaRepository";

describe("summarizeMessageRunArtifacts", () => {
  it("uses native web search artifacts as safe direct Search facts when search runs are absent", () => {
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
      searchActivity: [{
        displayName: "Search source",
        providerOperations: [{
          kind: "search",
          status: "complete"
        }],
        sourceCount: 1,
        sources: [{ title: "Example", url: "https://example.com" }],
        status: "complete"
      }],
      searchStrategy: "openai-native-web-search"
    });
    expect(JSON.stringify(summary)).not.toContain("ws_123");
  });

  it.each([
    ["cancelled", "cancelled"],
    ["error", "error"]
  ] as const)(
    "settles reloaded running Search evidence when the run becomes %s",
    (runStatus, expectedStatus) => {
      const summary = summarizeMessageRunArtifacts({
        events: [{
          payload: {
            artifactType: "search",
            payload: {
              action: { type: "search" },
              id: "ws_unresolved",
              status: "in_progress",
              type: "web_search_call"
            }
          }
        }],
        searchRuns: [],
        status: runStatus
      });

      expect(summary?.searchActivity).toEqual([
        expect.objectContaining({ status: expectedStatus })
      ]);
    }
  );

  it("projects the immutable logical Search name from the normalized request", () => {
    const summary = summarizeMessageRunArtifacts({
      events: [{
        payload: {
          artifactType: "search",
          payload: { status: "completed", type: "web_search_call" }
        }
      }],
      normalizedRequest: {
        searchPlan: {
          mode: "model_choice",
          options: [{
            displayName: "Company Gateway Search",
            optionId: "custom-web-search:connection-1"
          }]
        }
      },
      searchRuns: []
    });

    expect(summary).toMatchObject({
      searchActivity: [{ displayName: "Company Gateway Search" }],
      searchDisplayName: "Company Gateway Search",
      searchStrategy: "custom-web-search:connection-1"
    });
  });

  it("attributes a hosted artifact to its exact source when another client source was selected", () => {
    const summary = summarizeMessageRunArtifacts({
      events: [{
        payload: {
          artifactType: "search",
          payload: { status: "completed", type: "web_search_call" }
        }
      }],
      normalizedRequest: {
        searchPlan: {
          mode: "model_choice",
          options: [
            {
              adapterKind: "answer_provider_hosted",
              displayName: "Company Gateway Search",
              optionId: "custom-web-search:connection-1"
            },
            {
              adapterKind: "provider_model_client",
              displayName: "Perplexity Search",
              optionId: "perplexity-tool-search"
            }
          ]
        }
      },
      searchRuns: []
    });

    expect(summary).toMatchObject({
      searchActivity: [{ displayName: "Company Gateway Search" }],
      searchDisplayName: "Company Gateway Search",
      searchStrategy: "custom-web-search:connection-1"
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

  it("projects durable Search evidence directly when the terminal artifact append was interrupted", () => {
    const summary = summarizeMessageRunArtifacts({
      events: [],
      normalizedRequest: {},
      searchRuns: [{
        artifacts: {
          displayName: "Web Search · Sol",
          invocationId: "opaque-chat-invocation",
          providerOperations: [{
            id: "ws-1",
            kind: "search",
            ordinal: 0,
            pattern: null,
            queries: ["Moscow latest news"],
            status: "complete",
            url: null
          }],
          providerOperationsTruncated: false,
          sources: [{ rank: 1, title: "Moscow news", url: "https://example.com/moscow" }]
        },
        modelId: "gpt-5.6-sol",
        provider: "openai-compatible",
        query: "latest news in Moscow",
        requestPreview: { queryCharacters: 21 },
        status: "complete",
        strategyId: "web-search-sol"
      }],
      status: "complete",
      toolCalls: [{
        arguments: { query: "latest news in Moscow" },
        completedAt: "2026-07-31T12:02:25.900Z",
        ordinal: 0,
        providerCallId: "search-call-1",
        result: {
          callId: "search-call-1",
          content: [{ text: "Search completed", type: "text" }],
          name: "search_selected_engines",
          rawPreview: {
            finalProviderResponsePreview: {
              searchExecutions: [{
                displayName: "Web Search · Sol",
                durationMs: 145_800,
                invocationId: "opaque-chat-invocation",
                modelId: "gpt-5.6-sol",
                optionId: "web-search-sol",
                provider: "openai-compatible",
                providerOperations: [{
                  id: "ws-1",
                  kind: "search",
                  ordinal: 0,
                  pattern: null,
                  queries: ["Moscow latest news"],
                  status: "complete",
                  url: null
                }],
                providerOperationsTruncated: false,
                query: "latest news in Moscow",
                revisionId: "revision-1",
                sources: [{ title: "Moscow news", url: "https://example.com/moscow" }],
                status: "complete",
                usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 0 }
              }]
            }
          },
          status: "complete"
        },
        roundIndex: 1,
        startedAt: "2026-07-31T12:00:00.000Z",
        state: "complete",
        toolName: "search_selected_engines"
      }]
    });

    expect(summary).toMatchObject({
      searchCount: 1,
      searchActivity: [{
          displayName: "Web Search · Sol",
          providerOperations: [{
            kind: "search",
            queries: ["Moscow latest news"]
          }],
          query: "latest news in Moscow",
          sourceCount: 1,
          sources: [{ title: "Moscow news", url: "https://example.com/moscow" }]
      }],
      toolCallCount: 0,
      toolCalls: []
    });
    expect(JSON.stringify(summary)).not.toContain("opaque-chat-invocation");
    expect(JSON.stringify(summary)).not.toContain("gpt-5.6-sol");
    expect(JSON.stringify(summary)).not.toContain("openai-compatible");
    expect(JSON.stringify(summary)).not.toContain("revision-1");
  });
});
